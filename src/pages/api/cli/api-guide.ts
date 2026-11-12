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
coordinator notes; use authenticated local human controls for human actions. Creating a
workspace is the one exception: only the global token may (POST /api/cli/workspaces, ADR-0024).
The owner grant (ADR-0029) gives its one verified tab reads of every workspace and notes with
admission "owner" ("send a note as owner"); it never permits a foreign mutation.
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

  exit  meaning                                  codes                                      retry?
     0  success                                  —                                          —
     1  unexpected error                         unmapped code, 5xx, gh-unavailable,        investigate
                                                 outcome-unknown (a write lost its
                                                 connection: check the state first),
                                                 close-not-confirmed; unmapped server
                                                 codes, for example: burndown-unreadable,
                                                 workspace-create-failed,
                                                 tab-count-unreadable
     1  typed, no turn proven (tab send)         typed-not-submitted, submit-unconfirmed    never resend: inspect
                                                 (the text was typed; vel-RETRO-R3)         the tab first
     2  usage error                              bad or missing argument; invalid-request,  fix the command
                                                 lease-policy, watch-invalid,
                                                 reports-to-invalid, report-on-invalid,
                                                 note-too-large, note-invalid,
                                                 config-invalid, note-target-missing,
                                                 deploy-invalid, invalid-burndown,
                                                 burndown-too-large, remote-host-invalid,
                                                 remote-type-unsupported, cwd-missing,
                                                 orchestration-precondition-required,
                                                 orchestration-invalid
     3  conflict / refused by state              conflict, unauthorized, forbidden,         after the state changes
                                                 lease-held, lease-held-by-other,
                                                 watch-cap, inbox-not-held,
                                                 caller-unresolved, grant-tab-unverified,
                                                 grant-password-invalid, grant-locked,
                                                 config-version-conflict, note-cap,
                                                 grant-owner-active,
                                                 orchestration-conflict,
                                                 orchestrator-state-unknown,
                                                 orchestrator-live,
                                                 orchestrator-candidate-invalid,
                                                 orchestration-work-remains,
                                                 orchestration-recovery-required
     4  target gone (permanent)                  tab-not-found, session-not-running,        NEVER
                                                 target-changed
     5  not ready yet                            readiness-timeout;                         yes, bounded
                                                 startup-prompt (an agent at a Claude       (startup-prompt:
                                                 Code startup dialog; nothing typed)        after it is answered)
     6  server unreachable                       server-unreachable: connection refused,    yes, bounded
                                                 no port configured, a read interrupted;    (routes-absent:
                                                 routes-absent (404 without JSON: no such   no, until the
                                                 route — an older server, a foreign one,    cause is fixed)
                                                 or a malformed id);
                                                 remote-host-unreachable (a remote tab's
                                                 host did not answer)
     7  not found                                not-found (an unknown workspace or         —
                                                 record), lease-not-found, note-not-found,
                                                 watch-not-found, inbox-not-found,
                                                 deploy-not-found, config-not-found
     3  refused by state (ADR-0027)              wip-cap, config-store-unreadable           after the state changes
     1  (flow, ADR-0026)                         flow-unreadable; flow-write-failed         investigate
     2  (flow, ADR-0026)                         flow-invalid, flow-too-large               fix the command
     7  (flow, ADR-0026)                         flow-not-found (client-side: flow show)    —
     1  unexpected error (tab restart, ADR-0028) restart-not-confirmed                      inspect the tab
     2  usage error (tab restart, ADR-0028)      restart-unsupported                        fix the command
     3  conflict (tab restart, ADR-0028)         tab-busy                                   when idle, or --interrupt
     2  usage error (questions, ADR-0037)        question-invalid                           fix the question
     2  usage error (ledger, ADR-0033)           ledger-event-invalid,                      fix the command
                                                 ledger-reason-invalid,
                                                 ledger-experiment-invalid,
                                                 ledger-query-invalid, ledger-token-invalid,
                                                 ledger-too-large, ledger-type-reserved
     3  refused by state (ledger, ADR-0033)      ledger-experiment-cap,                     after the state changes
                                                 ledger-experiment-closed,
                                                 ledger-experiment-extended,
                                                 ledger-event-conflict
     7  not found (ledger, ADR-0033)             ledger-experiment-not-found                —
     1  unexpected error (ledger, ADR-0033)      ledger-store-failed                        investigate
     2  usage error (pool, ADR-0039)             pool-invalid                               fix the command
     3  refused by state (pool, ADR-0039)        pool-full, pool-unreadable,                after the state changes, or a local
                                                 pool-queued, pool-ticket-gone,             slot; never for a gate.no-local-
                                                 pool-no-pinned-host, pool-ask-cancelled,   fallback repository (ADR-0039 §6);
                                                 pool-ask-mismatch                          pool-queued: re-run with --ticket;
                                                                                            pool-no-pinned-host: fix the pin,
                                                                                            never wait (vel-POOL-ENF)
     6  no answer (pool, ADR-0039)               pool-timeout                               fall back to a local slot, log it;
                                                                                            never for a gate.no-local-
                                                                                            fallback repository (ADR-0039 §6)
     2  usage error (curator, ADR-0038)          curator-task-invalid,                      fix the command
                                                 curator-workspace-invalid
     3  refused by state (curator, ADR-0038)     curator-gate-refused, curator-refused,     after the state changes
                                                 curator-unavailable
     2  usage error (standing orders, ADR-0041)  so-invalid, so-too-large                   fix the command, or strike an order
     3  refused by state (orders, ADR-0041)      so-unreadable, so-struck                   after the file is repaired
     7  not found (standing orders, ADR-0041)    so-not-found                               —
     3  refused by state (proposal, ADR-0041)    so-proposal-refused (reason duplicate,     after the state changes
                                                 open-proposal or no-orchestrator-run)
     2  usage error (steer and send, story 14)   steer-reason-invalid,                      fix the command
                                                 terminal-not-command-line
     2  usage error (typed events, ADR-0043)     event-invalid,                             fix the command
                                                 event-scope-invalid
     3  refused by state (events, ADR-0043)      event-refused (each failed check),         after the evidence, scope
                                                 event-out-of-scope,                        or attempt changes
                                                 event-stale, event-check-unavailable
     5  not ready (typed events, ADR-0043)       event-no-recipient                         yes, bounded
     3  refused by state (note point, G7)        note-point-too-soon (one pointer per note  after 10 min
                                                 and per target tab in 10 min)
     5  not ready (note point, G7)               note-point-not-ready (a prompt, a halt,    yes, bounded
                                                 a policy refusal or text in the
                                                 composer; nothing typed)

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

## Pool (ADR-0039)

One scheduler places gates, builds, mutation runs, browsers, test services and agent tabs on this
host and the remote.hosts hosts (vel-D4: one shared budget per host).
Each known host has one budget: threads and memory (fleet config pool.budget.<host>.*, else the
read), less a control-plane reserve (default max(2, 25 % of threads) and max(4 GiB, 15 % of
memory)). Every kind reserves its envelope (pool.envelope.<kind>.*; defaults gate, build and
mutation 8 threads / 8 GiB, browser, test-service and tab 2 threads / 4 GiB) from the same worker
budget for the life of its lease; agent tabs from the layouts reserve the tab envelope, and each
workspace's enabled orchestrator tab draws on the reserve. Measured: host-a 32 threads / 91 GiB
(8 threads / 14 GiB reserved, 24 / 77 for workers); host-b 64 / 373 GiB (16 / 56, 48 / 317). This host is read through host-metrics on every call; each remote host by one ssh
read (\`sh -s\`, 5 s hard timeout, then pool.fallback.<alias> once) every 30 s. A failed read
makes the host unknown for 30 s: it shows no figures, never 0, takes nothing new, and keeps its
leases. A read older than 90 s is unknown too. A host that answered only through its fallback
alias shows its figures and "via", but "placeable" is false and "reason" says
"answers only through <fallback>; <alias> failed (...)": it takes nothing new.
Each read also measures the tailnet path to the alias that answered (else the host's own),
from this host (vel-RETRO-R2): \`ssh -G\` names the address, a lookup gives the IP, and a
tailnet IP (the RFC 6598 shared address space and fd7a:115c:a1e0::/48) gets one \`tailscale ping -c 1 --timeout 2s\`,
at most once per 5 minutes per alias (an unknown or a first relayed measurement is taken again
at the next read). A relayed path alerts on its second relayed measurement in a row.
Placement reads none of it: a relayed or slow host takes work as before, and the fleet view and
one flag alert to the portfolio Scrum Master seat report it.

GET /api/cli/pool   (any valid scope)
  \`purplemux pool show [--json]\`. The board's pool section reads the same model.
  Response: { "at", "totals": { "threads", "memTotalBytes", "memAvailableBytes", "knownHosts",
  "unknownHosts", "slots": { <kind>: { "used", "cap", "free" } } }, "hosts": [{   (totals' "free"
  counts placeable hosts only; "used" and "cap" count every known host)
  "host", "local", "state": "known"|"unknown", "placeable", "readAt", "via", "reason", "loadPerThread",
  "agentTabs", "slots", "path": null | { "kind": "direct"|"relayed"|"not-tailnet"|"unknown", "alert":
  null|"tailnet-relayed"|"tailnet-slow", "alias", "address", "ip", "peer", "region", "rttMs",
  "relayedReads", "slowMs", "measuredAt", "reason" } (null for this host and a host not measured
  yet; "not-tailnet" is an alias that dials outside the tailnet, such as host-b-lan; "unknown" is no
  pong, a via token that is not DERP, a peer relay or ip:port, or a measurement older than its
  5-minute TTL plus 90 s, never read as direct; relayedReads counts relayed measurements in a row,
  and "tailnet-relayed" needs 2; relayed wins over slow), "budget": null | { "threads", "memBytes", "reserveThreads", "reserveMemBytes",
  "workerThreads", "workerMemBytes", "maxLoad", "harnessSharePct", "used": { "product"|"harness"|
  "control-plane": { "threads", "memBytes" } }, "free": { "threads", "memBytes" } }, "metrics": null | { "threads", "load1", "load5", "memTotalBytes",
  "memAvailableBytes", "disks": [{ "path", "usedPct", "freeBytes" }], "gpus": null | [{ "index",
  "name", "utilPct", "memUsedMiB", "memTotalMiB" }], "sccacheSweep": null | { "state":
  "active"|"stopped"|"failed"|"not-installed", "failed", "timer": { "loadState", "activeState",
  "unitFileState", "result" }, "service": null | { ...the same } } } }] }. "stopped" is an
  installed timer that is stopped or disabled; null is not read. Totals count known hosts only.
  A job kind's "used" counts its leases; "cap" is how many of its envelopes the worker budget holds
  alone (or pool.slots.<host>.<kind>); "free" is how many more fit the worker budget left by the job
  leases now. For tab (ADR-0045) "used" is the worker tabs and live tab-start leases (coordinator tabs
  run on the reserve and are not counted), "cap" the ceiling, "free" the tab room's "free".
  "budget.used" holds the job leases and the coordinator tabs; worker tabs reach a job through the
  measured load and memory, never through this ledger.
  ADR-0045 per host: "tabRoom": null | { "room", "used", "ceiling", "ceilingSource":
  "pool.slots"|"default", "limit", "free", "binding": "threads"|"memory"|"ceiling", "freeThreads",
  "freeMemBytes" } (free threads = min(threads - reserve, max-load) - min(load1, load5) - unseen work;
  free memory = available - unseen work - reserve; room = tabs of the envelope both hold, 4 GiB floor
  kept; null for an unknown or fallback-only host), "tabsByWorkspace": { "<ws>"|"other": { "worker",
  "controlPlane" } }, "jobs": [{ "kind", "lease", "class", "holder": { "workspaceId", "tabId",
  "tabName", "admin" }, "item", "epic", "acquiredAt", "ageSeconds", "envelope" }] oldest first,
  "memFreeBytes", "diskRootUsedPct", "readAgeSeconds". A workspace the caller cannot read folds into
  "other", and its jobs show kind, class, age and envelope only (holder fields, item and epic null).
  "room": { "tab": { "host", "local", "free", "reason" }, "gate": { "host", "local", "reason" } }: a host
  only when it passes every check cleanly, else host null and why (\`purplemux pool room\`).
  "tabPlace": { "advised", "placedRemote", "here", "hereAtNoRoom", "last" }: the plain creates since
  the server started; hereAtNoRoom counts creates here while this host's tab room was 0 (the reserve
  is not protected then, only the WIP cap is).
  "queue": [{ "ticket", "kind", "class", "position", "envelope":
  { "threads", "memGb" }, "hosts", "holder", "queuedAt", "expiresAt" }] in admission order.
  503 pool-unreadable (exit 3) when the fleet config or the lease store cannot be read.

POST /api/cli/pool/acquire   (a tab token, or the admin token)
  Body: { "kind": "gate"|"build"|"mutation"|"browser"|"test-service"|"tab", "memGb"?: 0..1024,
          "threads"?: 1..4096, "ttlSeconds"?: n, "class"?: "product"|"harness"|"control-plane",
          "queue"?: true, "ticket"?: "pool-queue:<kind>-<n>",
          "panelType"?: "claude-code", "role"?: "evaluator", "item"?: "ITEM" }   (panelType, role, control-plane: kind tab only;
          item: the work item, [A-Za-z0-9][A-Za-z0-9._:#/@+-]{0,119}, shown on pool show)
  \`purplemux pool acquire --kind K [--mem GB] [--threads N] [--class C] [--queue [--wait S] | --ticket T]
  [--ttl 60m] [--panel-type T] [--role R]\`.
  Admission (vel-D4): the envelope is the kind's, raised by memGb and set by threads. Unknown and
  fallback-only hosts are skipped. A host takes the work only when every check passes: / under 85 %
  (jobs only); the pool.slots count cap if set; the envelope fits the worker budget left by every
  held lease (all ages: the ledger never reads measured use); a harness job fits its share
  (pool.harness-share-pct, default 25 % of the worker budget); measured free memory, less the
  leases taken within 60 s of the read, keeps 4 GiB after the envelope; min(load1, load5) plus the
  unseen leases' threads plus the envelope stays at or under max-load (default the host's threads);
  and no earlier ticket that could run there (its envelope fits the host's worker budget and, for
  harness, its share) waits for that host. Tab starts this server created within 60 s count as
  unseen in the measured checks. In pool.mode shadow (the default) the budget, measured-memory and
  sustained-load checks admit and log instead of refusing; the answer then carries "wouldRefuse". Jobs go to the lowest projected load per thread, then
  the most free memory, a tie staying on this host. A worker tab (ADR-0045) is admitted by its tab room
  and ceiling instead of the budget and measured checks; tabs go to the most room, then the most free
  memory, a tie going to a remote host. Only a claude-code
  tab with no role may leave this host (codex-cli and grok-cli cannot run remote, ADR-0022 §13; a
  coordinator is never remote, §20). A control-plane tab runs here on the reserve: never queued or
  refused, and its reason states the reserve use. Class control-plane is honoured only for the
  workspace's enabled orchestrator tab, resolved from the caller's identity; any other caller runs
  as product and the answer carries "downgrade" with the reason. A non-agent tab type is refused (no envelope).
  The slot is a lease "pool:<host>/<kind>-<n>" on the lease store (ADR-0011): the lowest free n,
  held by the caller's tab, default TTL 60m, at most 24h, note "pool mem=<GB> threads=<N>
  class=<C>". It ends with \`pool release\`, its TTL, or its holder tab (the lease sweeper).
  Placement and the slot number are taken inside the lease lock: two callers never get one slot.
  Response: { "host", "local", "slot": "gate-1", "lease": "pool:host-b-lan/gate-1", "expiresAt",
  "reason", "gateHost": null | "<pool.gate-host.<host>>", "class", "envelope": { "threads",
  "memGb" } }. A launcher that supports limits passes the envelope on (systemd-run --scope -p
  CPUQuota= -p MemoryMax=, docker --cpus --memory).
  Queue: with "queue": true a request that fits nowhere is 202 { "queued": true, "ticket", "kind",
  "class", "position", "of", "reason", "refusal", "expiresAt", "retryAfterSeconds", "envelope" }.
  The ticket is a lease "pool-queue:<kind>-<n>" (TTL 120 s) held by the caller. Re-ask with
  "ticket" within its TTL to keep the place (renewed at half its TTL); the admitted ticket becomes
  the slot in one transaction. Order: product, and harness under its share, by arrival; harness at
  its share last. \`pool release pool-queue:<kind>-<n>\` gives a place up.
  Ask token and pin (vel-POOL-ENF): "ask": "<[a-z0-9][a-z0-9-]{15,63}>", fresh per ask, goes into
  the slot's (or ticket's) note as "ask=<T>", so only that ask reclaims the slot. "pin": { "hosts":
  [pool host names], "local": true|false (the server's host), "gateHosts": [containers] } admits
  only on their union (a gate-host entry matches the hosts whose pool.gate-host names it); any
  kind. The answer echoes "ask" and "pin" (null when not sent); a pin by gate host also sets
  "gateHost" to that host's container, local or not. GET /api/cli/pool lists "features":
  ["ask-token", "host-pin"]; a client relies on either only when it is listed.
  Errors: 409 pool-full { "refusal": "no-known-host"|"no-free-slot"|"no-budget"|"harness-share"|
  "no-memory"|"overloaded"|"disk-full"|"queued-ahead"|"too-large" } with the measured and expected
  figures per host (exit 3; too-large never queues); 409 pool-no-pinned-host { "refusal":
  "no-pinned-host" } (the pin matches no pool host the work may use; it names the pin and the hosts;
  a configuration refusal, never queued, exit 3); 409 pool-ask-cancelled (the ask token was
  cancelled, exit 3); 409 pool-ticket-gone (the ticket expired or was released, exit 3); 400
  pool-invalid (exit 2; also a bad ask or pin, or another caller's live ask token); 400 lease-policy
  (a TTL over 24h, exit 2); 403 caller-unresolved (no tab, exit 3).
  Client rule: the CLI waits 2 s. No answer exits 6 (pool-timeout); the caller does what it does
  without the pool and logs it: a lane uses its local slots, but a repository in
  gate.no-local-fallback never runs here (below). A lease a late answer took expires at its TTL.
  A gate passes --ttl of at least its gate timeout, or renews the lease while it runs.

POST /api/cli/pool/release   Body: { "lease": "pool:<host>/<kind>-<n>" | "pool-queue:<kind>-<n>", "ask"?: "<T>" }
  \`purplemux pool release LEASE [--ask T]\`. The holder only (409 lease-held-by-other, exit 3); 404
  lease-not-found (exit 7); a name that is not a pool slot is 400 pool-invalid. With "ask", the
  lease is released only when its note carries that token, else 409 pool-ask-mismatch and nothing
  is released (a reused slot name is never another ask's to free).
  Response: { "released": <lease view> }
  Body { "ask": "<T>" } alone (\`purplemux pool release --ask T\`) cancels the ask, in one
  transaction: every slot and ticket of the caller that carries T is released, and the caller's
  mark "pool-cancel:<hash of the caller and T>" (600 s, no budget) refuses the caller's acquire
  with T that lands later (409 pool-ask-cancelled). A timed-out acquire is reclaimed this way,
  never by name. A lease view and a log show a token as its first 8 characters only.
  Response: { "released": [lease names], "cancelled": "<T>" }

The engineering gate's keys map onto the pool (migration, ADR-0039 §6; gate.sh and remote-gate.sh
do not change until they read the pool, and every key keeps working until then):
  gate.route=remote           gate.sh asks \`pool acquire --kind gate\` for a repository in
                              gate.remote-repos; local, or a repository outside it, stays here.
  gate.remote-repos           unchanged: the repositories whose gates the pool places.
  gate.no-local-fallback      (default acme-ledger-api acme-ledger-event-consumer) never runs here: a
                              local answer, pool-timeout or pool-full is handled as today (queue on
                              the gate host, or REFUSED-REMOTE).
  a remote answer             remote-gate.sh with ORCH_GATEHOST_HOST=<gateHost>: the pin needs no
                              gate.remote-hosts entry (GATE_HOST resolves only against the list).
  gate.remote-hosts entries   stay until gate.sh reads the pool. alias:slots:api-slots on a pool
                              host maps to pool.gate-host.<host>=<alias> and
                              pool.slots.<host>.gate=<slots> (gatehost-replica:6:2 ->
                              pool.gate-host.host-b-lan=gatehost-replica, pool.slots.host-b-lan.gate=6);
                              api slots stay in remote-gate.sh's host queue. gatehost-runner2
                              (lfr-runner2, outside the pool, OD-7) has no pool host.
  gate.slots                  pool.slots.<this host>.gate.

## Workspaces

GET /api/cli/workspaces
  Response: { "workspaces": [{ "id": "...", "name": "...", "directories": [...] }] }

POST /api/cli/workspaces                                (purplemux workspace create -n NAME -d DIR...)
  Body: { "name": "...", "directories": ["/abs/primary", "/abs/other", ...] }
  Admin token only (ADR-0024): the one workspace write the global token holds, because no
  workspace exists yet to scope a token to. A workspace or tab token answers 403 forbidden;
  inside a tab the CLI presents the tab's own token, so run it from a shell outside every tab
  (or with PMUX_TAB_TOKEN and PMUX_TOKEN unset). Cooperative, not a security boundary.
  Creates the workspace through the same store call as the web UI: the registry entry, the
  first terminal tab with its tmux session, and the workspace's own agent homes. directories[0]
  is the primary (the cwd of new tabs) and must exist; every entry must be an existing absolute
  directory (nothing is created). Name: 1-100 characters, trimmed, no control characters, and
  unique across workspaces ignoring case. Orchestration starts off. One audit line
  (workspace-create) goes to ~/.purplemux/audit/coordination.jsonl.
  Response: { "id": "ws-...", "name", "directories": [...], "defaultTabId": "tab-..." | null }
  Errors: invalid-request 400 (exit 2: bad body, missing or non-directory path), forbidden 403
  (exit 3), conflict 409 (exit 3: the name is taken; the message names the holder's id),
  workspace-create-failed 500 (exit 1: nothing was created). A failure to register the first
  tab after the create answers 200 with "defaultTabId": null; the workspace exists.

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
  An owner grant (ADR-0029; capability "owner", workspaces ["*"]) lets its one verified grantee tab
  read every workspace, including one created later, and send notes with admission "owner"; it
  confers no mutation right either. Every token sees it in this list. Only the web UI creates one
  (POST /api/grants with the purplemux password); a second while one is active answers 409
  grant-owner-active (exit 3). Reads under it are audited as owner-read, at most once per
  (grant, workspace) per hour.
  Response: { "grants": [...], "refused": [{ "capability", "file", "error", "code": "grant-store-unreadable" }] }.
  Each grant file fails alone: grants holds the records of each readable file (the grants in force),
  refused names an unreadable one (always present, [] when both read; not filtered by scope). Only
  both files refused answers 500 grant-store-unreadable naming both. grant list then prints the
  readable grants and exits 1 with the refusal on stderr.

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
    "cliState", "lastEvent", "busySince", "reportsTo", "reportOn", "identity", "host"? }] }
  "host" is present only on a remote tab (ADR-0022): the ssh alias whose tmux runs it.
  cliState / lastEvent ({ name, at, seq }) / busySince are the live status (null when unknown).
  A busy tab whose lastEvent is "stop" waits only on open background work (WAITING, ADR-0018:
  a turn that ended with no marker line while its own background shells, agents or registered
  jobs run sends no nudge).

POST /api/cli/tabs
  Body: { "workspaceId": "WS", "name"?: "...", "panelType"?: "terminal" | "claude-code" | "codex-cli" | "grok-cli" | "agent-sessions" | "web-browser" | "diff",
          "model"?: "...", "reasoning"?: "...", "launch"?: boolean, "reportsTo"?: "tab-...", "reportOn"?: ["DONE", ...] | "DONE,BLOCKED",
          "host"?: "HOST", "cwd"?: "/abs/dir", "overCap"?: { "reason": "1..500 chars" } }
  Invalid panelType returns HTTP 400 with validPanelTypes.
  WIP cap (ADR-0027): an agent tab (claude-code, codex-cli, grok-cli; local or remote; --no-launch
  tabs too) is refused while the workspace already holds fleet config tabs.cap-per-workspace agent
  tabs (default 8; terminal, web-browser, diff and agent-sessions tabs do not count). The count and
  the add run under one lock, so two creates at cap - 1 cannot both pass. Refusal: 409 { "code":
  "wip-cap", "error": "WS holds 8 of 8 agent tabs", "workspaceId", "count", "cap", "capSource" }
  (exit 3); nothing is created. A fleet config that cannot be read refuses every agent create with
  503 { "code": "config-store-unreadable" } (exit 3), never "no cap". "overCap" passes the cap: only
  from a verified tab that is its workspace's enabled orchestrator, else 403 forbidden (exit 3);
  a reason that is empty or longer than 500 characters is 400 invalid-request (exit 2). A create
  that passed the cap appends { "event": "tab-over-cap", "workspaceId", "tabId", "count", "cap",
  "reason", "by" } to ~/.purplemux/audit/coordination.jsonl. The human's own create
  (POST /api/layout/pane/<paneId>/tabs) is never refused; its agent answer gains "wip".
  "host" runs the tab's tmux on that host over ssh (ADR-0022). It must be listed in fleet config
  remote.hosts, else 400 { "code": "remote-host-invalid" }; terminal and claude-code tabs run remote,
  codex-cli and grok-cli do not: 400 { "code": "remote-type-unsupported" } (both CLI exit 2). A host that does not answer
  over ssh is 503 { "code": "remote-host-unreachable", "host" } (exit 6). The kit's CLI runs once
  on the host before the session starts; when it does not run there, 502 { "code": "remote-kit-broken",
  "host", "line" } (exit 1; "line" names the cause, e.g. a missing module) and no agent starts. The pane gets
  PMUX_TAB_ID, PMUX_WORKSPACE_ID, PMUX_URL (this server) and its own tab token, never the
  workspace token. A remote claude-code tab's hooks, transcript and CLI reach this server, so
  status, result, send, close and the watchdog work as for a local tab; status serves "host".
  "host": "auto" asks the pool (ADR-0039, vel-D4): only a claude-code tab with no role may go to a
  known remote host (the most free memory; a tie stays here), then passes the same checks as an
  explicit host. An agent tab takes a tab lease (300 s) for its envelope until it is in its
  layout. A start that fits no host is 202 { "code": "pool-queued", "ticket", "position", "of",
  "reason", ... } and creates nothing: re-POST with "queueTicket" to keep the place (\`tab create
  --host auto\` waits and re-asks for you). A pool refusal is 409 pool-full. "poolClass":
  "control-plane" runs the tab here on the reserve, never queued. A "cwd" missing on the chosen
  host gives that start back and asks this host alone. Only a first ask with no "queueTicket"
  that the pool does not answer in 2 s creates the tab here without the budget; a late answer is
  given back. Every other pool failure is an answer and creates nothing: 409 pool-ticket-gone,
  409 pool-full, 400 pool-invalid, 503 pool-timeout (a re-ask), 503 pool-unreadable. The answer adds "placement": { "host", "local", "reason", "fallback",
  "envelope" }; "fallback" is true when the pool's first answer was not used.
  "cwd" is the tab's start directory, an absolute path that must exist on the tab's host,
  else 400 { "code": "cwd-missing" } (exit 2). On a remote host the create also pre-trusts that
  cwd for Claude Code there (vel-PMX-FU): the folder-trust key on the cwd itself, never on a
  parent, and no trust for "/", a top-level directory or the home. A cwd you do not name (the
  workspace default) is trusted only inside a workspace directory, as before.
  "reportsTo" names a live tab of the SAME workspace that receives this tab's watchdog nudges
  ahead of the workspace orchestrator; anything else is 400 { "code": "reports-to-invalid" }
  (CLI exit 2). It is cleared when that tab closes.
  "reportOn" (ADR-0025) names the end-line markers whose turn-marker nudges the target receives:
  a non-empty subset of DONE, BLOCKED, NEEDS-DECISION, READY-TO-MERGE, CHECKPOINTED, as an array
  or a comma-separated string; absent, null or "all" forwards every marker. A turn that ends on a
  marker outside the list is classified and recorded (tab status shows turnEnd) but nudges nobody,
  and no idle nudge follows it. An unknown name or an empty list is 400 { "code": "report-on-invalid" } (exit 2).
  Creates a tab in the first pane of the workspace. Agent tabs (claude-code / codex-cli / grok-cli)
  auto-launch their CLI with purplemux hooks wired, so the tab reports cliState and can
  receive prompts via send immediately. "model" sets the agent model (claude --model /
  grok -m / codex --model). "reasoning" sets the effort — claude-code: "low" | "medium" |
  "high" | "xhigh" | "max" (claude --effort; omitted = the launching user's GLOBAL default,
  so an orchestrator spawning workers should always pin it to the intended tier); grok-cli:
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" (grok --effort);
  codex-cli: "minimal" | "low" | "medium" | "high" (model_reasoning_effort). "launch": false
  keeps the old bare-shell behavior.
  Response: { "tabId", "workspaceId", "paneId", "sessionName", "name", "panelType", "agentProviderId", "agentSessionId", "launched", "host"?,
              "wip"?: { "count", "cap", "overCap" } } — wip on an agent tab: the count with the new tab; overCap = count > cap
  A codex-cli tab whose launch fails after the create keeps its tab, and the tab counts against the
  cap: 500 { "error", "reason", "tabId", "generation"?, "launchState", "wip" } when the launch
  could not be prepared or submitted, 503 with the same fields when it was not confirmed.

GET /api/cli/workspaces/<WS>/tab-count   (any scope that may read WS)
  The workspace's agent tabs against the WIP cap; \`purplemux tab count -w WS [--json]\` prints
  "<count> <cap>". Repository hooks read it instead of counting tmux sessions.
  Response: { "workspaceId", "count", "cap", "capSource": "workspace-config" | "workspace-config-invalid" | "fleet-config" | "default" | "default-invalid", "overCap", "capReason"? }
  "capReason" is present with workspace-config-invalid: why the workspace's stored value was not used.
  404 not-found (exit 7) for an unknown workspace; 503 config-store-unreadable (exit 3); 500 tab-count-unreadable (exit 1).

GET /api/cli/tabs/<tabId>?workspaceId=WS
  Tab info.
  Response: { "tabId", "workspaceId", "paneId", "name", "sessionName", "panelType", "agentProviderId", "agentSessionId", "reportsTo", "reportOn" }

PATCH /api/cli/tabs/<tabId>?workspaceId=WS
  Body: { "reportsTo"?: "tab-..." | null, "reportOn"?: [...] | "DONE,BLOCKED" | null } — one or both, and
  nothing else. reportsTo sets or clears the nudge target (same rules as create; a tab cannot report
  to itself); reportOn sets or clears (null / "all") the markers it forwards (ADR-0025).
  Response: { "tabId", "workspaceId", "reportsTo", "reportOn" } with the tab's current values.
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

POST /api/cli/tabs/<tabId>/restart?workspaceId=WS
  Body: { "clear"?: boolean, "interrupt"?: boolean }   (ADR-0028; own workspace only)
  A fresh agent process under the SAME tab id: the tab's processes are reaped (as for a close),
  its tmux session is recreated with the same name, and the server relaunches the agent with the
  tab's own agentLaunchConfig (model, effort), cwd, scope, reportsTo and host. No tab-closing or
  tab-closed fires, so the tab's token, leases, watches, probes, notes, grants, reports-to links
  and Mission Control run binding stay. A hook-time token is replaced by a fresh launch token.
  The agent resumes its last session where the provider can; clear starts a new one; a remote tab
  restarts fresh. A terminal tab restarts its shell. The tab's registered background jobs die with
  the reap and raise no failure; probes stay.
  Response: { "ok": true, "workspaceId", "tabId", "resumed": boolean,
              "resumeSkipped"?: "clear" | "no-session" | "remote" | "cwd-lost", "identity": "launch" | "hook" | "none",
              "reaped": { "killed": N, "survivors": N }, "launchState"?: "active" | "held" }
  400 { "code": "restart-unsupported" } (exit 2) for a web-browser, diff or agent-sessions tab.
  404 { "code": "tab-not-found" } (exit 4). 409 { "code": "tab-busy", "cliState" } (exit 3) while
  the tab is mid-turn or holds a pending launch or turn; interrupt: true abandons the turn, and the
  audit line records it. 503 { "code": "remote-host-unreachable" } (exit 6): nothing was killed.
  500 { "code": "restart-not-confirmed", "reaped" } (exit 1): a process or the session outlived the
  reap, or the restart failed after the kill (a remote host that stops answering, the tab gone),
  and nothing was relaunched. cwd-lost: the tab's cwd was gone, so the agent started fresh in the
  nearest existing parent. An attached terminal is closed with 4002 "Tab restarting" (never 1000)
  and re-attaches; a connect during the restart gets 4002. 403 forbidden (exit 3) for the admin token or another
  workspace. Each restart appends one "tab-restart" line to ~/.purplemux/audit/coordination.jsonl.
  The tab gains lastRestartAt in layout.json; the fleet row shows restartedAt.
  The web UI and the phone use the cookie twin POST /api/tabs/<tabId>/restart?workspaceId=WS
  (a human session and this server's Origin).
  CLI: purplemux tab restart -w WS TAB_ID [--clear] [--interrupt] [--json]
       prints "ok TAB_ID restarted (resumed)" or "(fresh)".

POST /api/cli/tabs/<tabId>/send?workspaceId=WS
  Body: { "content": "...", "waitMs"?: 0..600000, "raw"?: boolean }
  Send text to the tab and press Enter. Typed into Claude Code, bracketed paste elsewhere.
  For an agent tab (claude-code / codex-cli / grok-cli) the send waits until the tab can
  accept a turn, up to waitMs (default 60000). A booting agent swallows the Enter after a
  paste, so sending into one reports success over an agent that never starts. waitMs: 0
  answers with the current state instead of waiting. Terminal and browser tabs are ungated.
  Response: { "status": "sent", "submitted": boolean, "cliState": string | null,
              "confirmation": "prompt-submit" | "composer-empty" | null, "resubmitted": boolean,
              "notSubmitted"?: "typed-not-submitted" | "submit-unconfirmed" }
  Before it types into idle, ready-for-review or busy-waiting-at-prompt, an agent tab must also show an empty
  composer on screen; a timeout then carries "screen": "composer-not-empty" | "composer-unreadable" |
  "interactive-prompt-active". After the typing, an agent tab must prove the submission: a turn-starting
  prompt-submit hook (or busy from a state that was not busy) within 5 s (10 s for a remote tab,
  scaled by the host's remote.timeout-ms / 5000 when it is set, at most 60 s). The hook is read again
  after every capture, so one that lands during a slow remote capture still counts. A remote tab's
  screen gate waits at least two of the host's ssh budgets, so one slow capture is never the answer.
  The send waits for its proof outside the tab's dispatch lock, so the agent's hooks apply, and inside
  the tab's send gate, so no other dispatch types into the tab until the send answers.
  confirmation "composer-empty" counts only for a tab with no prompt-submit hook. Text still in the
  composer at 1.5 s gets ONE more Enter (resubmitted: true). Without proof, submitted is false and
  notSubmitted names why: typed-not-submitted (the text is still in the composer) or
  submit-unconfirmed (no turn seen, the screen proves nothing). The CLI then exits 1. The text was
  typed, so never resend it: a resend types it twice. A terminal tab has no turn: "submitted" reads
  the screen, best-effort, and "confirmation" is null.
  404 { "error": "Tab not found", "code": "tab-not-found" }
  409 { "error": "submit-unconfirmed", "code": "submit-unconfirmed", "tabId", "typed": false, "detail": "no-submit-evidence" }
    — the server holds no status for the agent tab to prove a turn against, so nothing was typed. Exit 1.
  409 { "error": "agent-not-ready", "code", "tabId", "cliState", "detail": "readiness-timeout" | "session-not-running", "waitedMs"?, "screen"? }
    — nothing was pasted, so a later Enter cannot submit a half-forgotten prompt.
  409 { "error": "agent-not-ready", "code": "startup-prompt", "tabId", "cliState", "startupPrompt":
      "folder-trust" | "external-imports" | null, "startupPromptLabel", "detail" } — at once, with no
      wait: the agent waits at a Claude Code startup dialog, and a paste would answer it. Answer the
      dialog in the tab, or create the tab with --cwd under a workspace directory (pre-trusted).
  409 { "error": "agent-target-changed", "code": "target-changed", "tabId" } — the tab was replaced.
  tab-not-found, session-not-running and target-changed are permanent (CLI exit 4): never
  retry them. readiness-timeout is retryable (CLI exit 5), a bounded number of times;
  startup-prompt (also exit 5) only after someone answers the dialog.
  400 { "code": "terminal-not-command-line", "tabId", "panelType": "terminal", "lines", "error" } (exit 2,
    D30): the target is a terminal tab and the text holds more than one line (trailing line breaks
    are not counted). A shell runs each line as a command, so prose fails line by line. Nothing is
    typed. The error says "saw N lines; expected one shell command line". A multi-line command (a
    heredoc, a quoted multi-line string, a backslash continuation) needs raw: true (--raw); prose
    belongs in an agent tab.

POST /api/cli/tabs/<tabId>/steer?workspaceId=WS
  Body: { "content": "...", "interrupt"?: boolean, "reason"?: "1..500 chars", "raw"?: boolean }
  A mid-turn correction. With interrupt, the server sends Escape first (the agent stops its turn and
  keeps its session), then types the content; without it, the content is typed into the composer
  and waits for the turn to end. Own workspace only (403 forbidden, exit 3, for the admin token or
  another workspace).
  Interrupt default (story 14): a caller that is an agent tab (claude-code / codex-cli / grok-cli,
  named by its tab token or its tmux session, ADR-0010) does NOT interrupt by default. Any other
  caller tab (a terminal tab) and any caller that names no tab, or a tab the layout does not hold
  ("unidentified"), interrupts by default, as before. interrupt: false is accepted from every
  caller. interrupt: true needs a reason from every caller.
  The classification is ADVISORY, not access control: a process with the workspace token that sends
  no tab identity is "unidentified" and gets the interrupt default. The audit is the record: EVERY
  steer that interrupts, by default or on request, appends one "steer-interrupt" line to
  ~/.purplemux/audit/coordination.jsonl: the target, the caller (kind agent | other | unidentified,
  tab, panel type, identity), explicit, the reason ("(none given)" for a default interrupt) and
  whether the Escape landed.
  CLI: purplemux tab steer -w WS TAB_ID [--interrupt --reason TEXT | --no-interrupt] [--raw] CONTENT...
       Flags are read only before the content (for tab send too): every word from the content on is
       sent byte for byte ("tab send T git log --raw" types "git log --raw"), and -- ends the flags.
  Response: { "status": "steered", "interrupted": boolean }
  400 { "code": "steer-reason-invalid" } (exit 2): interrupt: true without a reason, a reason over
    500 characters, or a reason without interrupt: true. Nothing is typed. The error text says what
    it saw and what it expected.
  400 { "code": "terminal-not-command-line", ... } (exit 2): as for send (D30).
  404 tab-not-found, 409 target-changed and session-not-running: as for send (exit 4).

GET /api/cli/tabs/<tabId>/status?workspaceId=WS
  Response: { "tabId", "workspaceId", "alive", "command", "cliState", "agentProviderId", "agentSessionId", "claudeSessionId",
              "probes": [...], "backgroundJobs": [...], "turnEnd": {...} | null, "identity" }
  cliState "startup-prompt": the agent waits at a Claude Code startup dialog that no hook reports
  (folder trust, external CLAUDE.md imports); the row then also carries "startupPrompt"
  ("folder-trust" | "external-imports" | null), "startupPromptLabel" (words for a person) and
  "startupPromptSince" (ms). tab list rows carry the same three fields in that state.
  A remote agent tab (one with "host") that is alive also carries "agentProcess": { "state":
  "present" | "absent" | "unknown", "reason"? }: its agent process, walked on that host. Prove a
  remote tab dead with it before a respawn: "absent" or alive false is dead; "unknown" (the host did
  not answer) is not, and neither is exit 6 remote-host-unreachable (vel-D61).
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

## Evaluator role (ADR-0040)

An evaluator tab drives one preview origin in headless Chrome and reads state; it cannot change
the repository or read the denied credential paths. The tool configuration enforces it, not
prompt text. Seat instructions reach it as prompt text (tab send): it loads no CLAUDE.md, no
.claude/commands and no plugin.

POST /api/cli/tabs  { ..., "role": "evaluator", "previewUrl": URL, "pgService"?: NAME }
                    (purplemux tab create -w WS --role evaluator --preview-url URL [--pg-service NAME])
  A local claude-code tab (an omitted panelType means claude-code). previewUrl is an http(s)
  URL without credentials on a plain hostname or IPv4 host ([A-Za-z0-9.-]; bracketed IPv6 is
  refused: chrome-devtools-mcp cannot compile it into its URL pattern), not on this server's
  own port; its origin is stored as "previewOrigin". pgService (optional, ^[A-Za-z0-9_-]{1,63}$)
  names a ~/.pg_service.conf entry; every launch command then starts PGSERVICE=NAME claude ...
  The answer and GET /api/cli/tabs carry "role", "previewOrigin" and "pgService". Set once: no
  update path changes them,
  a panelType change answers 409 conflict naming the role, and every launch, resume,
  auto-resume and tab restart applies them. 400 invalid-request (exit 2) for an unknown role,
  another panelType, a "host", a missing or non-http previewUrl, a previewUrl without the
  role, a bad pgService or one without the role, or a ~/.local/bin/headless-chrome under
  Chrome 149 (the reason names its version).

Tool set — measured at session start (claude 2.1.317): Bash, Glob, Grep, Read and the
chrome-devtools MCP tools (32 in chrome-devtools-mcp 1.12.0); no other built-in exists
(EnterWorktree, Task, Cron*, Write, ... answer "No such tool available").
  --tools Read,Grep,Glob,Bash                 the whole built-in set
  --disallowedTools                           Edit, Write, NotebookEdit, and Read(...) deny rules for
                                              ~/.purplemux, ~/.config, ~/.aws, ~/.ssh, ~/.claude, ~/.codex,
                                              ~/.gnupg, ~/.docker, ~/.netrc, ~/.git-credentials,
                                              ~/.pg_service.conf, ~/.pgpass and any file
                                              named *token*, *secret*, *.pem, *.key anywhere (//**/ rules).
                                              A Read rule also binds
                                              Grep, Glob and the read-only Bash commands;
                                              Bash(docker|ps|pgrep|lsof|ss:*) are denied
  --permission-mode dontAsk                   anything not allowed is denied, never prompted;
                                              --dangerously-skip-permissions is never passed
  --allowedTools                              Bash(~/.purplemux/bin/evaluator-sql:*) (absolute path),
                                              mcp__chrome-devtools, Read, Grep, Glob
  --strict-mcp-config --mcp-config            one MCP server, chrome-devtools
  --setting-sources ''                        user, project and local settings do not widen the list;
                                              the hook --settings file still loads
Bash also runs Claude Code's own read-only commands without a rule (measured: cat, head, ls,
wc, pwd, git status, git log inside the repository). Their write flags are denied (git log
--output, sort -o, find -fprint), as are git branch/stash/config, env, curl, redirects and
anything reading a denied path.
Probes:
  HTTP        through the browser, on the preview origin only: navigate_page, new_page, or
              evaluate_script with fetch (the preview's own session). There is no curl.
  SQL         ~/.purplemux/bin/evaluator-sql "<one statement>": psql 18 from
              ~/.local/lib/pg-client, scrubbed env, -X, -d service=$PGSERVICE (the tab's
              --pg-service), read-only transaction; refuses a second argument, a backslash, a
              second statement, a missing or bad PGSERVICE and a missing psql. An env prefix
              (PGSERVICE=other ...) is denied. The guard is the service's SELECT-only role
              (ADR-0040 §3: no CREATE, write, signal or server-file roles, no dblink,
              default_transaction_read_only); the wrapper is a second layer.
  Browser     chrome-devtools-mcp@1.12.0 on ~/.local/bin/headless-chrome (Chrome 149+,
              --headless --isolated --allowedUrlPattern <previewOrigin>/*): file:, every other
              origin and every other port are blocked. Its file tools, take_screenshot filePath
              included, reach only ~/.purplemux/evaluator/<tabId>/ (and its tmp/), which
              outlives the tab: the client's MCP roots (claude's cwd) are filtered out.
An evaluator tab is never an orchestrator: designating one answers 409
orchestrator-candidate-invalid (exit 3). The Electron browser routes (/browser/*) are not an
evaluator surface and gained nothing.

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
  Response: { "backgroundJobs": [{ "pid", "label", "host"?, "alive", "state", "registeredAt", "ageS" }] }
  host: the ssh alias the pid lives on, for a job registered from a remote tab (the
  verified calling tab's host, else the target tab's); the pid and its files are read
  there. state: alive | exited | unknown. alive is true only when the job is attested
  running; unknown means its host has not answered and it is NOT known to have exited.
  A host that fails 3 probes in a row sends one BACKGROUND JOB HOST UNREACHABLE nudge
  to the reportsTo tab or orchestrator; the job stays watched.

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
epic sends require the verified current source orchestrator, or the verified tab holding the active
owner grant (admission "owner", with its grantId; it routes like an orchestrator's note, and each
send is audited as owner-note). Admission is persisted across source orchestrator handover and
survives a later revoke of the owner grant. With no target orchestrator the note is "undeliverable" with a reason and
never falls back to a worker. When a note bounces (target-epic-unowned or target-coordinator-unavailable, at the send
or later), the sender's live tab gets one line at once, "[purplemux note n-…] you sent it at <time>; it bounced
(<reason>): …", and one line in its digest; the note waits for a recipient until it expires. The recipient's tab
receives only the inbox's fixed line "[purplemux note n-…] from <ws>/<tab> at <time> — purplemux note
show n-…, then purplemux note ack n-…" (from "owner (<ws>/<tab>)" for an owner note); the subject and
body are never typed. Every note view carries fromLabel, the same server-made words after "from". If that tab closes
before the line is delivered, the note re-routes. One reminder reaches the recipient 30 min after
the line reached its composer, and one notice reaches the sender's tab (if live): at 15 min when the line
has not reached the recipient's composer (the portfolio Scrum Master seat's digest gets one line too), else at
60 min; no more. A coordinator's digest, and each watchdog nudge typed to it, carry
"N notes pending, oldest <age>: run purplemux note list --open --to-me" while notes wait for it. A note unacked or undeliverable for 14 days expires (one notice to a live sender); acked and
expired notes are pruned 14 days later. An ack types nothing into the sender's tab (F6): the sender
reads the state, ackedBy and ackComment with \`note list --from-me\` or note show. At turn start, run
\`note list --open --to-me\`.

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
  sender that is neither the verified current source orchestrator nor the owner-granted tab.

GET /api/cli/notes[?open=1][&toMe=1][&fromMe=1][&epic=SLUG]
  Notes the caller's workspace sent or receives (admin: all), without bodies.
  Response: { "notes": [{ "id", "from", "to", "subject", "state", "deliveredTo", "routedAt",
    "deliveredAt", "ackedAt", "ackedBy", "ackComment", "bodyBytes", "fromLabel", "receipt", ... }] }

GET /api/cli/notes/<id>
  The recipient workspace, the sender workspace, or admin. Response: { "note", "body" }.
  404 note-not-found (exit 7); 403 forbidden (exit 3).

POST /api/cli/notes/<id>/ack
  Same-workspace notes: the recipient workspace. Cross-workspace and legacy unknown-source notes:
  the verified currently routed recipient coordinator. Body: { "comment"? (≤ 500) }.
  A non-empty comment queues one "acked … with a comment" line to the sender's tab (above); the
  comment itself is pulled with note show.
  Response: { "note" } in state "acked". 404 note-not-found (exit 7); 403 forbidden (exit 3),
  also for a note that is not delivered.

POST /api/cli/notes/<id>/point   (CLI: note point ID; G7)
  The verified current orchestrator of the sender workspace, for its own note that is routed to another
  workspace's enabled orchestrator and has not reached that composer yet. No body (absent, null or {}; any
  field is 400 note-invalid). The server types ONE fixed line into that orchestrator, busy included:
    [purplemux note <id>] from <ws>/<tab> at <time> needs action now: run purplemux note show <id> now,
    then purplemux note ack <id>
  ("carries an owner decision" in place of "needs action now" only for a note sent under an owner grant).
  The target takes it only with an empty composer: no permission prompt, no option list, no usage-limit
  halt, no needs-input or startup-prompt state, and the dispatch policy passes. A submitted line is the
  note's composer receipt (deliveredAt), and its queued notice is withdrawn. One pointer per note and one
  per target tab per 10 min. Response: { "status": "sent", "submitted", "noteId", "target", "cliState",
  "line", "notSubmitted"? }. 403 forbidden (exit 3); 404 note-not-found (exit 7); 404 tab-not-found /
  409 session-not-running (exit 4); 409 note-point-not-ready (exit 5); 409 note-point-too-soon (exit 3);
  200 with notSubmitted "typed-not-submitted" (exit 1: never point again, inspect the tab).

## Typed worker events (ADR-0043)

A verified worker tab announces a routine result without its orchestrator retyping it. The server
checks the evidence first, then delivers the event as a note (admission mode "event") to the target
epic's recipient by the note rules above. Nothing is typed but the notes' fixed line, and no tab
or terminal control is granted. landed and blocked-on also send one short status note to the
sender's own coordinator (not when it is the recipient); review-ready does not, and the coordinator
reads it with note list.

PUT /api/cli/worker-events/scope
  The workspace's verified, designated live coordinator only (else 403 forbidden, exit 3).
  Body: { "tabId" (a live tab of this workspace), "epic" (held as epic:<slug> by a live tab of this
  workspace), "story"?, "dependsOn"? (≤ 16 epic slugs), "attempt"? (≥ 1; default the previous
  attempt, else 1; never lower) }. Response: { "scope" }. 400 event-scope-invalid (exit 2).

GET /api/cli/worker-events/scope
  The scopes of the caller's workspace (admin: all). Response: { "scopes": [...] }.

DELETE /api/cli/worker-events/scope?tabId=TAB
  The coordinator clears one tab's scope. Response: { "cleared": true|false }.

POST /api/cli/worker-events
  A verified tab with a scope, on this server's host (a remote tab, ADR-0022, is refused as
  event-check-unavailable). Body: { "type": "review-ready"|"landed"|"blocked-on", "toEpic" (the
  scope's epic or one of its dependsOn), "payload" }. Every payload: "repo" (absolute; under the
  workspace's directories or PMUX_EVENT_EVIDENCE_ROOTS), "branch", "head", "base" (full object
  ids), "attempt" (the scope's attempt). review-ready (the hand-off for review) adds "key",
  "gateLog", "reviewDir", and "receipt"? (absent on a first hand-off; checked when given); landed
  adds "key", "gateLog", and "target"? (the branch it landed in, default main); blocked-on adds
  "reason", "clearInput" (≤ 500 characters). Unknown fields are refused. Checks: evidence-paths
  (each path resolves under the roots, of the right kind); range (refs/heads/<branch> is head, and
  base is its ancestor; for landed, once the branch is gone or has moved on, head may instead be an
  ancestor of refs/heads/<target> or refs/remotes/origin/<target>); review-ready and landed also
  gate-verdict (the last run says VERDICT=VALID and SETTLED=yes), gate-tree (the last run's
  GIT_TREE_END= is the tree of head), patch-id (the server's PMUX_EVENT_PATCH_ID_CMD, a JSON array
  whose first item is an absolute path outside the sender's repo, prints key; unset, the event is
  event-check-unavailable). The command and the server's own git reads run in the sender's repo
  with GIT_CONFIG_COUNT overrides that outrank its .git/config (core.fsmonitor, core.hooksPath,
  diff.external, core.pager, core.editor, core.sshCommand, core.askPass, credential.helper,
  core.alternateRefsCommand, gpg.program). Attribute drivers cannot be pinned that way, so the
  script must use plumbing (git diff-tree, git patch-id) with --no-ext-diff --no-textconv, never
  porcelain that a repo's diff or filter drivers can redirect. review-ready also review-folder
  (range.txt, diff.patch, status.txt,
  patch-id.txt naming key, record.md) and receipt (named <key>.md; no verdict: BLOCK). The scope
  is read again inside the notes lock after the checks.
  Response: { "event": { "type", "toEpic", "state": "delivered", "checks", "noteId",
  "statusNoteId" }, "note", "status" }. 400 event-invalid (exit 2); 422 event-refused with
  "failures": [{ "check", "measured", "expected" }] (exit 3); 403 event-out-of-scope or forbidden
  (exit 3); 409 event-stale (exit 3): an old attempt, a scope changed during the checks, or an
  event already sent whose note has not expired ("noteId", "noteState"); 409
  event-check-unavailable (exit 3); 409 note-cap (exit 3); 503 event-no-recipient (exit 5): no
  live holder or coordinator, nothing stored.

## Harness watches (ADR-0015)

A watch is a one-shot subscription owned by the calling tab. The server evaluates it and sends
the owner ONE inbox line when the condition holds, then deletes it; it dies with its tab.
  pr OWNER/REPO#N    --until merged | closed | head-moved | checks-settled
  ref OWNER/REPO@REF --until moved
  lease NAME         --until free   (no unexpired record: an acquire would succeed)
GitHub reads use the server's own gh, every intervalS (default 120, 60-3600); a lease watch is
evaluated on each lease release and every pass. A watch expires after ttlSeconds (default 24 h,
max 7 d) with one notice. Three failed reads in a row send one "failing" notice carrying a
server token (http-404, http-403, timeout, auth, gh-missing, sso-config, other); watch list shows the error
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

Auth waits (ADR-0041): kind "auth", target an AWS profile (stored as "aws-sso:<profile>"), until
"signed-in", optional "ledgerItem" (a ledger item key). The server reads only that profile's AWS
SSO cache file (~/.aws/sso/cache/<sha1 of its sso-session, or of a legacy sso_start_url>.json)
every 60 s by default and starts no aws process (DEC-261); a profile ~/.aws/config does not define
as SSO is 400 watch-invalid; so is a wait from a remote tab (the cache read is this server's host),
and a tab whose host the layout cannot tell is 403 caller-unresolved (exit 3; never taken for a local
tab). It fires on a sign-in: a token valid (accessToken present, expiresAt at least 5 min ahead) and
different from the one valid at creation, if any. It then sends
"[purplemux watch w-…] aws-sso:<profile> is signed in: its SSO token is valid until <UTC>; retry
the step that needed it — watch cleared", and the server clears, with a ledger "clear" event, the
open "deploy-auth" wait of ledgerItem and of every item of the workspace whose clear input names
the profile as a word. An unreadable config or cache file is the failing token "sso-config".
CLI: purplemux wait add --auth PROFILE [--item KEY] [--ttl 24h] [--label TEXT].

## Standing orders (ADR-0041)

The owner's rules, said once: ~/.purplemux/standing-orders.md (fleet; seeded with the W8 orders
SO-1..SO-7) and ~/.purplemux/workspaces/<ws>/standing-orders.md. Each order SO-<n> (ids unique on
the host) has text (≤ 600), source (the owner message id and UTC date, ≤ 300), scope (default the
file's owner), check (a hook or test name, default "prose") and state (active | struck). The active
fleet and workspace orders are written into the workspace's claude-prompt.md at every Claude launch
(tab create, restart, resume) and on every change, with the time they were rendered; a change also
rewrites the kit copy on each remote host that runs a tab of the workspace. Claude reads the file
once, at launch: a running session keeps the list it started with, so a change also sends each live
agent tab it reaches one urgent line: "[purplemux standing order] SO-<n> added|struck (<owner>): <text> — …".
purplemux so list is the authority; an order missing there is struck.

GET /api/cli/standing-orders[?workspaceId=WS][&all=1]
  A tab reads the fleet's and its own workspace's orders; admin reads one workspace or every file.
  Active orders only unless all=1. Response: { "orders": [{ id, owner, text, source, scope, check,
  state, added, struck? }] }.
POST /api/cli/standing-orders   { "text", "source", "workspaceId"?, "scope"?, "check"? }
  No workspaceId: a fleet order (admin token only, else 403 forbidden). A workspace order: that
  workspace's tabs or admin. 400 so-invalid names the field; 400 so-too-large when the active orders
  one workspace loads would pass 8192 bytes, with the measured size. Response: { owner, order, bytes,
  workspaceId, promptsWritten, tabsNotified }.
POST /api/cli/standing-orders/<SO-n>/strike   { "reason" }
  The same authority as the order's file. 404 so-not-found; 409 so-struck when already struck (exit 3).
  The order stays in its file with "struck: <UTC> — <reason>".
POST /api/cli/standing-orders/proposals   { "text", "why", "cites"?, "scope"?, "check"? }
  ADR-0041 §1 amendment D7: the launch tab of the selected portfolio manager only (selectedScrumMasterScope);
  every other caller, the admin token included, gets 403 forbidden (exit 3). why: one line, at most 200;
  cites: at most 300, the owner message the manager relays (into the item's context, never the order's
  source). Checks before the item opens: 400 so-invalid, 400 so-too-large; 409 so-proposal-refused with
  "reason": duplicate | open-proposal | no-orchestrator-run (exit 3). Then the server opens item
  so-proposal-<16 hex text><8 hex time> on the manager's bound run: format 2, confirm (yes | no), class
  scope, no default, nothing recommended. 201 { itemId, workspaceId, runId, workspaces, liveTabs, bytes }.
  The owner's Yes files the fleet order as the server's admin caller with source "owner answer <answerId>
  on MC item <itemId> (<UTC date>), proposed by <ws>/<tab>"; No, text alone, a withdrawal
  (attention.cancelled) or 72 h with no answer files nothing. The item serves proposal: { state
  (open | filed | declined | expired | withdrawn | not-filed), orderId, reason } | null; reason is a sentence,
  and a not-filed code is recorded and audited, never served. For expired and not-filed the proposer tab
  gets one "[purplemux standing order] proposal <itemId> …" line.
CLI: purplemux so add (-w WS | --fleet) --text T --source S [--scope S] [--check C]; so propose --text T
--why W [--cites C] [--scope S] [--check C]; so strike SO-N --reason R; so list [-w WS] [--all] [--json].

## Fleet config (ADR-0019)

Versioned string values that tools read at call time, so changing one needs no message to
anyone: no broadcast, no nudge, no inbox notice. Every change is audited to
~/.purplemux/audit/coordination.jsonl. Keys match ^[a-z][A-Za-z0-9._-]{1,63}$; values are one
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
  turn-end.source
               row (unset) or classifier. With row, a worker's \`purplemux done\` row decides its turn end with
               the end line by one order: the higher rank wins (NEEDS-DECISION > BLOCKED > the rest), the row on a
               tie (F6). No stop is held. classifier: the end-line classifier alone, as before F6. Admin token only.
  hook.stop-payload
               on (unset) or off. On, the Claude stop's own last_assistant_message is the turn's tail; off, the
               transcript tail is read again (F6). Admin token only.
  fleet-status.stall-minutes  fleet-status.waiting-long-minutes  fleet-status.unanswered-minutes
  fleet-status.composer-minutes
               The fleet flag thresholds (ADR-0023), in minutes (0, 10080], decimals allowed:
               STALL? after N quiet minutes (default 30), WAITING-LONG after M minutes waiting
               (120), UNANSWERED after K minutes (30), and STALL? after C minutes of composer text
               (2). Read on every fleet read; unset or invalid means the default. Written by the
               admin token or an enabled orchestrator (ADR-0019).
  remote.hosts The ssh aliases that remote tabs may use (ADR-0022), comma-separated; a name that is
               not an ssh alias, or "auto", is 400 config-invalid. Unset means no remote host. They
               are also the pool's remote hosts (ADR-0039). Admin token only.
  remote.callback-url
               The URL a remote tab's hooks and CLI use to reach this server, http(s)://host[:port].
               Plain http only to loopback, 100.64.0.0/10, a *.ts.net name or a bare name on
               remote.callback-allow-hosts; else 400 config-invalid. Unset means
               http://<this hostname>:<port>. Admin token only.
  remote.callback-allow-hosts
               Bare lower-case host names that remote.callback-url may name over plain http,
               comma-separated. Admin token only.
  remote.timeout-ms, remote.timeout-ms.<ssh alias>
               The ssh budget of one tmux call or host check on a remote host, whole ms
               5000..120000 (else 400 config-invalid); the per-host key wins. Every other remote
               budget (create 10 s, close 20 s, transcript, spool and job reads 10 s) scales by
               value/5000; ssh's ConnectTimeout is one second under each call's budget (at least 1 s).
               Read when the fleet store changes; unset means 5000 (vel-D61). Admin token only.
  context.rotate-at-tokens
               The context a seat rotates at (ADR-0036): a whole number of tokens 50000..900000.
               Read every 30 s; unset or invalid means 300000 (an invalid value is logged). A tab's
               own --rotate-at wins. Written by the admin token or an enabled orchestrator (ADR-0019).
  tabs.cap-per-workspace
               The WIP cap (ADR-0027): an integer 1..200 of agent tabs per workspace, one value
               for the fleet. Unset means 8 (capSource "default"); any other invalid value means 8
               (capSource "default-invalid", the value logged). Admin token only (exit 3 forbidden
               for a tab): any one orchestrator could otherwise raise it for every workspace.
  tabs.cap-per-workspace.<workspaceId>
               One workspace's WIP cap (ADR-0039), the id as written (case kept): it wins over the
               fleet value for that workspace (capSource "workspace-config"). Both cap keys must be an
               integer 1..200 when written (else 400 config-invalid). A stored value that is invalid
               anyway serves the fleet cap with capSource "workspace-config-invalid" and "capReason",
               and is logged. Admin token only, except that the Portfolio Scrum Master's verified tab
               writes it for a workspace in its portfolio selection, with a reason and the version it
               read (ADR-0045); the fleet value stays with the admin token.
  pool.slots.<host>.<gate|build|mutation|browser|test-service|tab>
               A pool host's count cap for the kind (ADR-0039), a whole number 0..64 (0: none there);
               <host> is the lower-case pool host (this host's name or a remote.hosts alias).
               Unset means no count cap: the shared budget alone admits (vel-D4). Read on every
               pool read. For tab it is the host's tab ceiling, a hard refusal in both modes; unset,
               the ceiling is floor(worker memory / tab memory), refused in enforce only (ADR-0045).
               Admin token only, except that the Portfolio Scrum Master's verified tab writes the
               tab form, with a reason and the version it read (ADR-0045).
  pool.budget.<host>.threads
  pool.budget.<host>.mem-gb
  pool.budget.<host>.reserve-threads
  pool.budget.<host>.reserve-mem-gb
  pool.budget.<host>.max-load
               A pool host's one budget (vel-D4): threads 1..4096 and memory 1..65536 GiB (unset:
               the read), the control-plane reserve (unset: max(2, 25 % of threads) threads and
               max(4, 15 % of memory) GiB), and the sustained load that refuses new work (unset: the
               host's threads, a placeholder: tune it from the shadow would-refuse log before
               pool.mode=enforce). An invalid stored value keeps the default. Admin token only.
  pool.envelope.<kind>.threads
  pool.envelope.<kind>.mem-gb
               What one job or tab of the kind reserves (vel-D4): threads 1..4096 and 0..4096 GiB.
               Unset: gate, build and mutation 8 threads / 8 GiB; browser, test-service and tab 2
               threads / 4 GiB. A request's memGb raises the memory, its threads sets the threads.
               Admin token only.
  pool.harness-share-pct
               The share of each worker budget harness work may hold (vel-D4), a whole percent
               0..100. Unset means 25. Admin token only.
  pool.path.slow-ms
               A direct tailnet path whose RTT is at or above this is "tailnet-slow" (vel-RETRO-R2),
               whole milliseconds 1..60000. Unset means 250. Reported, never a refusal. Admin token only.
  pool.mode
               shadow or enforce (vel-D4 review r1), checked when written. Unset, and a stored
               value that is neither, mean shadow: the budget (no-budget), measured-memory
               (no-memory) and sustained-load (overloaded) checks admit the work, log one
               "pool would-refuse (shadow, admitted):" line with min_load, pending_threads,
               envelope, max_load, memory and agent_tabs, and count it ("wouldRefuse" on GET
               /api/cli/pool and "pool" on the fleet view). enforce refuses them. Every other
               check refuses in both modes. Go-live runs shadow for a day, tunes
               pool.budget.<host>.max-load from the log, then sets enforce. Since ADR-0045 a worker
               tab's room (no-room) and the default tab ceiling (tab-ceiling) are shadowed the same
               way. Admin token only.
  pool.tab-place.<workspaceId>
               What a tab create without --host does in that workspace (ADR-0045): advise (unset,
               and any stored value that is not one of the three), here or place. advise creates the
               tab here and logs the room answer after the create started; place sends a claude-code
               tab with no role to the room answer when that host passes every check cleanly, is in
               remote.hosts and has the cwd (--cwd, else the workspace's first directory), else here;
               here asks nothing. A plain create is never queued or refused by the pool. Admin token
               only, except that the Portfolio Scrum Master's verified tab writes it for a workspace
               in its portfolio selection, with a reason and the version it read.
  pool.fallback.<alias>
               The ssh alias the pool read tries once when <alias> fails (the tailnet alias
               behind a LAN alias, e.g. host-b behind host-b-lan). Unset means one try. Admin
               token only.
  pool.gate-host.<host>
               The gate-host container on <host> that a remote gate pins (its ssh alias, e.g.
               gatehost-replica); \`pool acquire --kind gate\` returns it as "gateHost". Admin
               token only.
  curator.routing.workspaces
               The workspaces where a curator task in state routing routes (ADR-0038; consult v2
               point 6): workspace ids, comma-separated. Unset (the default) routes nowhere; every
               other workspace only logs. acme-ledger-v2's workspace stays out until v2 records its
               own row. Admin token only.
  curator.min-interval-ms
               The least gap between two curator call starts, whole ms 0..600000 (default 0). The
               kodit rule's own 10 s limit (ADR-0038 §7) applies whichever is longer. Admin token
               only.
  curator.enabled
               on (the default) or off: off makes no curator call at all and the board shows the
               curator down, switched off. Admin token only.
  curator.standing-order.candidates
               Workspaces whose owner messages labelled standing-order file no SO-n: the label goes
               as one digest line to the named tab, a candidate for its own decision record (story
               23; consult v2 point 6). ws-...=<tab name> pairs, comma-separated, or none. Unset means
               ws-ldhziO=v2-scrum-master. A value REPLACES that default: keep the pair in it, or
               acme-ledger-v2's workspace files SO-n. It applies once classify-owner-message routes,
               whether or not the workspace is in curator.routing.workspaces. Admin token only.
  flow.window-minutes  flow.lock-busy-percent  flow.queue-length  flow.oldest-minutes
               The flow-flag thresholds (ADR-0026): the busy-share window in minutes 10..10080
               (default 360), the busy percent 1..100 (80), the queue length, a whole number
               1..10000 (10), and the oldest-item age in minutes 1..10080 (240). Read on every flow
               read; unset or invalid means the default, and the server logs why. Written by the
               admin token or an enabled orchestrator (ADR-0019).
  attention.auto-answer.bookkeeping-minutes
               The bookkeeping auto-answer rule (ADR-0031): an integer 1..10080 of minutes. Unset
               (the default) or any invalid value is off (an invalid value is logged). Admin token
               only (exit 3 forbidden for a tab): the rule answers items in every workspace.
  mission.question-format.min-version
               The oldest Mission Control question format the events route accepts (ADR-0037): 1
               (the default) accepts a v1 question and returns its format-2 lint; 2 refuses a new v1
               question with 400 question-invalid. Unset, invalid or unreadable means 1. Admin token
               only (exit 3 forbidden for a tab): the owner raises it (OD-10).
  alerts.flags  alerts.flag-repeat-minutes
               Flag alerts (ADR-0032). alerts.flags "off" stops every flag alert; any other value,
               or unset, is on. alerts.flag-repeat-minutes, 1..10080 (default 60, decimals allowed),
               is the least time between two alerts for one flag. Admin token only (exit 3
               forbidden for a tab): they decide what reaches the owner's phone.

GET /api/cli/fleet-config
  Any valid scope. Response: { "values": { "<key>": { "value", "version", "setAt", "setBy": { "workspaceId", "tabId", "admin" } } } }
GET /api/cli/fleet-config?key=KEY
  Response: { "key", "value", "version", "setAt", "setBy" }; 404 { "code": "config-not-found" } (CLI exit 7) when unset.
GET /api/cli/fleet-config?history=1[&key=KEY]
  The last 200 changes, oldest first: { "history": [{ "key", "oldValue", "newValue", "version", "at", "by", "reason"? }] }.
  An unset shows as newValue null. "by" carries "role": "portfolio-scrum-master" for that writer.
PUT /api/cli/fleet-config/KEY   { "value": "6", "expectedVersion"?: 4, "reason"?: "1..500 characters" }
  Writers (ADR-0019, ADR-0045): the admin token writes every key; the workspace's enabled orchestrator tab
  writes the keys that are not admin-only; the Portfolio Scrum Master's verified tab (the manager tab of
  the current portfolio selection, a live coordinator) writes tabs.cap-per-workspace.<ws> and
  pool.tab-place.<ws> for a workspace in its selection, and pool.slots.<host>.tab. Its write needs
  "reason" and "expectedVersion" (400 config-invalid without), is refused when the selection changed
  between the check and the write (403), and is audited with the reason and the selection. A refused write by a
  launch-verified tab, or one naming a Scrum Master key form, is audited as "fleet-config-refused" with the key, the
  code, the refusal kind and the reason given, never the value; a Scrum Master same-value set (changed false) as
  "fleet-config-unchanged" with its reason.
  Response: { "key", "version", "value": { "value", "version", "setAt", "setBy" }, "changed" }. Setting the value a key already holds changes
  nothing (no version, no audit line). 400 config-invalid (exit 2); 403 forbidden (exit 3);
  409 config-version-conflict (exit 3) when expectedVersion is not the stored version (0 = never set).
DELETE /api/cli/fleet-config/KEY   { "expectedVersion"?: 5, "reason"?: "..." }
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
  — read with: purplemux tab result -w <ws> <tab>" (up to 5 READY-TO-MERGE lines ride along),
  unless the tab's reportOn (tab create --report-on / tab reports-to --on, ADR-0025) leaves that
  marker out: then the stop is recorded and no nudge goes anywhere.
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
  (400 invalid-burndown, exit 2) names the field, what it saw and what it expected; nothing is
  stored.
  Unknown fields are dropped. At most 100 epics; history keeps the newest 2000 rows by "at"
  (the CLI trims before sending); the stored snapshot is at most 1 MiB (413 burndown-too-large, exit 2,
  otherwise).
  Each publish replaces the previous one. The portfolio board renders the burndown of the
  selected Scrum Master's workspace and marks it stale 2 h after "generated_at".

GET /api/cli/workspaces/<workspaceId>/burndown         (purplemux burndown show -w WS)
  Response: { "burndown": { "workspaceId", "receivedAt", "snapshot": { ... } } | null }
  A stored file that does not validate is 500 burndown-unreadable (exit 1), never null.

## Flow (ADR-0026)

POST /api/cli/workspaces/<workspaceId>/flow            (purplemux flow publish -w WS --json @FILE)
  Body: one flow snapshot (src/types/flow.ts IFlowSnapshot). Every key is required; an unknown key
  is refused, so a typo never drops data. Times are Unix ms:
        { "schemaVersion": 1, "generatedAt", "source": "<1..64>",
          "queues": [{ "name": "<1..64, unique>", "capacity": 1..10000 | null,
                       "items": [{ "id": "<1..128, unique in its queue>", "label": "<= 120" | null, "since",
                                   "state": "queued" | "active" | "held", "pinned": bool, "holder": "<= 128" | null }] }],
          "locks":  [{ "name": "<1..64, unique>", "heldBy": "<= 128" | null (free), "since" | null (null when free) }],
          "meters": [{ "name": "<1..64, unique>", "value": finite, "unit": "<= 16", "limit": finite | null,
                       "windowMinutes": 1..10080 | null }],
          "flags":  [{ "text": "<1..200>", "severity": "info" | "warn" | "block" }] }
  Own workspace only: a peer, a grant or the admin token gets 403 forbidden. At most 20 queues,
  500 items per queue, 20 locks, 50 meters and 20 flags; no time more than 5 min after the server
  clock. No string holds a control character (newline, ESC) or a bidi control (U+061C, U+200E,
  U+200F, U+202A-U+202E, U+2066-U+2069); an identifier (source, a queue, lock or meter name, an item
  id, holder, heldBy, unit) also holds no other format character such as ZWJ or a soft hyphen,
  while label and flag text keep them (emoji sequences, ZWNJ scripts). A held lock names a
  non-blank heldBy. A refusal (400 flow-invalid, exit 2) names the field, what it saw (format and
  bidi characters echoed as \\u{...}) and what it expected; the stored record does not change.
  Over 1 MiB serialized: 413 flow-too-large (exit 2; the CLI refuses before it sends). 404
  not-found for an unknown workspace. 500 flow-write-failed (exit 1, investigate) when the store
  cannot write; the previous record stays as it was.
  Response: { "ok": true, "workspaceId", "receivedAt", "generatedAt", "historyRows", "historyReset", "bytes" }
  The server appends one history row per publish, derived from the snapshot; a producer never
  sends history: { "at": receivedAt, "queues": { name: length }, "oldest": { name: since of the
  oldest item | null }, "locks": { name: held }, "meters": { name: value } }. The record keeps the
  newest 2000 rows and at most 4 MiB; the oldest rows go first. A stored record that does not
  validate is kept as flow.json.corrupt-<receivedAt> by the next publish, which starts a fresh
  history and answers "historyReset": true. "bytes" is the stored record's size.

  Example, from a board script on a timer (the CLI prints ok <receivedAt> <historyRows>):
    purplemux flow publish -w "$PMUX_WORKSPACE_ID" --json @flow.json
    ok 1793001600000 412
  with flow.json:
    { "schemaVersion": 1, "generatedAt": 1793001590000, "source": "v2-flow",
      "queues": [{ "name": "landing", "capacity": null, "items": [{ "id": "lane/a0", "label": null,
                   "since": 1792760000000, "state": "queued", "pinned": false, "holder": null }] }],
      "locks": [{ "name": "landing", "heldBy": "lane/b1", "since": 1792999800000 }],
      "meters": [{ "name": "gate-slots", "value": 4, "unit": "slots", "limit": 5, "windowMinutes": null }],
      "flags": [{ "text": "main is red", "severity": "block" }] }

GET /api/cli/workspaces/<workspaceId>/flow[?history=all|window|none]
                                                       (purplemux flow show -w WS [--json] [--history all|window|none])
  Read scope: the own token, a peer, a grant, the admin token. history defaults to all; window
  keeps the rows of the last flow.window-minutes (360 by default); none sends no rows. Response:
  { "flow": { "workspaceId", "receivedAt", "snapshot", "history" } | null, "stale": bool | null,
  "derived"?: { "flags": [{ "rule", "subject", "text", "severity": "warn" | "block" }],
  "lockBusyShare": { name: 0..1 | null }, "lockKnownMinutes": { name: minutes },
  "insufficientHistory": [lock name], "windowMinutes", "thresholds": { "windowMinutes",
  "lockBusyPercent", "queueLength", "oldestMinutes" } } }; stale is true more than 10 min after
  receivedAt; derived is absent when flow is null. A stored record that does not validate
  answers 500 flow-unreadable (exit 1), never "no flow published". For "flow": null the CLI
  prints "no flow published" and exits 7 (flow-not-found, decided by the CLI). flow show prints
  each lock's busy share and a "derived flags" section.
  The derived flags come from the full record, whatever history the answer carries, sorted block,
  warn, then rule and subject:
    stale       no publish for 10 min. A stale record raises only this flag.
    lock-busy   the lock's busy share over the window is at least flow.lock-busy-percent. The share
                is time-weighted: each history row's state holds until the next row (the newest
                until now); a gap over 10 min, a clock step back and a row without the lock are
                unknown time. Known time under half the window: share null, the lock listed in
                insufficientHistory, no flag.
    queue-long  a queue holds at least flow.queue-length items.
    queue-old   a queue's oldest item is older than flow.oldest-minutes.
    queue-full  (block) a queue with a capacity holds at least that many items.
    meter-over  a meter's value is above its limit.
  Flag alerts (ADR-0032): every 60 s the server reads the fleet flags (STALL?, WAITING-LONG,
  UNANSWERED) and these derived flags. A flag raised since the previous read sends the human one
  status-socket notification:alert of kind "flag" with "flag": { "source": "fleet" | "flow",
  "rule", "subject", "text" }. tabId is the flagged tab, or the workspace's enabled orchestrator
  for a flow flag and a workspace-level UNANSWERED; with no orchestrator nothing is sent. A flag
  that stays raised sends nothing more, and one raised again alerts only after
  alerts.flag-repeat-minutes. The first read after a server start sends nothing, and so does the
  first good read of any source read late; an unreadable store raises nothing and clears nothing;
  a target that cannot be checked is retried next tick. The orchestrator-only alert setting does
  not apply. No inbox notice is sent: the alert is for the human, not for an agent.
  Attention alerts: an item that first becomes owner-visible (state "open", humanReview.humanNeed
  not "none") sends one notification:alert of kind "attention-opened": an attention.opened that is
  open at once, or an attention.updated that moves a candidate to open. Title "Mission Control:
  answer needed", body the item title, "itemId", and "question": { "formatVersion" (1|2),
  "decision", "answerType", "options": [{ "id", "label", "needsText" }], "revision" } so a phone can
  answer it from the notification. FCM carries "question" as JSON for a v2 item only, and only while
  the data map stays under 3,584 UTF-8 bytes; Web Push does not carry it. tabId is the opening tab,
  else the workspace's orchestrator. A candidate, a replayed event, an update of an item already
  open, an answer, a resolve and a cancel send nothing; an item alerts once per server process.

## Spend (ADR-0030)

GET /api/cli/spend?workspaceId=WS[&since=YYYY-MM-DD][&until=YYYY-MM-DD][&by=tab|day|model|role|seat|phase|item]
                                                       (purplemux spend show -w WS [--since D] [--until D] [--by ...] [--json])
  Read scope on WS. since/until are UTC days, both inclusive; the default is the last 7 UTC days
  and by=tab. Spend keeps the last 92 UTC days (today − 91 … today), including usage whose
  transcript has since left the disk. A bad date, since after until, a range over 92 days, a
  since before today − 91, or a bad "by" is 400 invalid-request (exit 2). An unknown workspace
  is 404 not-found. An index that cannot be read (index.state "unavailable") has no numbers:
  the CLI prints the served error and exits 1.
  Response (ISpendView):
    { "workspaceId", "from", "to", "by", "generatedAt",
      "totals": ISpendRow, "rows": [ISpendRow], "unattributed": ISpendRow | null,
      "roleBasis"?: "current-orchestrator",
      "dayBasis": { "claude": "message", "codex": "session-start", "grok": "session-start" },
      "index": { "state": "ready"|"indexing"|"unavailable", "filesIndexed", "filesTotal",
                 "indexedThrough": <ms>|null, "error"? } }
    ISpendRow: { "key", "label", "providerId": "claude"|"codex"|"grok"|null, "inputTokens",
      "outputTokens", "cacheReadTokens", "cacheCreationTokens", "totalTokens", "sidechainTokens",
      "costUsd": <USD estimate>|null, "unpricedTokens" }
  sum(rows) + unattributed = totals for every token field. Usage of an agent session that no
  tab binding names is "unattributed": never dropped, never 0. Subagent transcripts count under
  the parent session's tab and are reported in sidechainTokens. costUsd sums the tokens of
  priced models; tokens of a model with no known price go to unpricedTokens, and a row with no
  priced token has costUsd null (print "—", never $0). by=role rows are "orchestrator" (the
  workspace's enabled orchestrator NOW) and "other". Transcripts are read by a background
  index; while index.state is "indexing" the numbers are partial. A request never parses a
  transcript.
  by=seat rows are tab names (the open tab's name, else the name recorded with the binding).
  by=phase and by=item read the work-item ledger: each Claude message counts at its UTC 5-min
  slot, for the ledger item its tab held (holder = the tab's id or name) at the slot's midpoint;
  of several, the one with the latest event. Phases: plan, build, review, evaluate, land,
  coordinate, and "other" (the tab held no item). The wait reason decides first (review-queue,
  review-findings: review; rework: build; receipt-rekey and every land and deploy reason: land;
  owner: coordinate), else the item type (slice: build; review: review; gate, experiment:
  evaluate; range, landing, deploy: land; owner-issue: plan; mc-item: coordinate); seat items
  never count. by=phase|item serve at most 7 UTC days (else 400 invalid-request naming the cap).
  Their answers add "unattributedReasons": [ISpendRow] (keys no-binding, no-message-time for
  Codex, Grok and pre-slot usage, ledger-unreadable, no-ledger-history before the ledger's
  horizon, no-held-item for by=item; they sum to "unattributed") and "phaseBasis": { "slotMs":
  300000, "ledgerHorizon": <ms>|null (null: no item yet), "ledgerReadable" }. Mission Control
  refuses by=phase|item with workspaceId=all. Every ISpendRow also carries "cacheReadCostUsd":
  the cache reads' part of costUsd, null when not priced or a Codex/Grok session cost cannot be
  split.

GET /api/cli/spend/phases?workspaceId=WS[&day=YYYY-MM-DD]   (purplemux spend phases -w WS [--day D] [--json])
  Read scope on WS. One UTC day (default today; from today − 91 to today, else 400
  invalid-request) as the by=phase ISpendView, each row with "wallMs" (distinct 5-min slots
  with usage x 5 min; null for usage with no message time), plus "day" and
  "cacheReadPerLandedItem": { "day": M, "7d": M }, M = { "metric":
  "cache_read_tokens_per_landed_item", "window", "from", "to", "cacheReadTokens", "landedItems"
  (range landings the store's projection applied in the window, one per applied close with state
  landed: a repeat, orphan or re-sent close counts none; null when the ledger cannot be read or holds
  no item for the workspace), "value" (null when not measured), "reason" (why not
  measured, else null) }.

## Ledger (ADR-0033)

The work-item ledger: producers push every state change of a work item; the server derives how
long each item waited and why, from a closed vocabulary. Stored in ~/.purplemux/ledger.sqlite.
Every answer carries Cache-Control: no-store.

POST /api/cli/workspaces/<workspaceId>/ledger/tokens   (purplemux ledger token issue -w WS --producer NAME [--out FILE])
  Body: { "producer": "<[a-z0-9][a-z0-9._-]{0,63}>" }. Own workspace only (the admin token, a peer
  or a grant gets 403 forbidden). Response: { "scope": "ledger:emit", "workspaceId", "producer",
  "token", "issuedAt" }. Issuing a producer again rotates its token. The server's own producer
  name, purplemux (and purplemux:*), is reserved: 400 ledger-token-invalid. The CLI writes the response
  to a 0600 file (default ~/.purplemux/ledger-tokens/WS/NAME.json). The server keeps only a SHA-256
  of the token. A ledger:emit token is not a CLI token: every other route answers it 401 or 403.
  An unsafe name: 400 ledger-token-invalid (exit 2).

POST /api/cli/workspaces/<workspaceId>/ledger/events   (purplemux ledger emit -w WS --token-file F [--json @FILE|@-|JSON])
  Header x-pmux-token: the ledger:emit token of this workspace. Any other token: 403 forbidden
  (another workspace's ledger token, a tab, workspace or admin token); none or unknown: 401
  unauthorized. The producer name comes from the token, never from the body.
  Body: { "events": [1..500 events] }, at most 1 MiB serialized (413 ledger-too-large). Event:
        { "event_id": "<1..128, producer-chosen>", "at": Unix ms (no older than 92 days, at most 5 min ahead),
          "item_type": slice | range | gate | review | landing | deploy | owner-issue | mc-item | seat | experiment,
          "item_key": "<item_type>:<id>" (1..200; range:<lane>:<key12>, gate:<tree12>:<started>,
                      landing:<started>, slice:<lane>, seat:<ws>:<tab-name>, deploy:<env>:<sha12>,
                      owner-issue:<id>, mc-item:<id>),
          "kind": open | state | wait | clear | close | link,
          "state"?: "<1..64>" (required for state; optional on close: landed, dropped, superseded, answered),
          "wait_reason"?: required for wait, absent otherwise,
          "holder"?: "<1..128>", "clear_input"?: "<1..500>" (wait only),
          "parent_key"?: "<type>:<id>" (required for link), "attrs"?: { "<key>": string | number | bool | null } (<= 32 keys) }
  Wait reasons (closed): build-review: review-queue, review-findings, rework, receipt-rekey; land:
  not-armed, pre-arm-gate, fold-batch, own-lane-order, group-partner, guard-hold, gate-slot,
  pre-flight-gate, land-queue, lock-wait, under-lock-gate, red-main, chain-down; deploy:
  deploy-queue, deploy-run, deploy-auth, external-team; people: owner, agent-idle; hosts: host-load.
  An unknown key is refused. Identifiers hold no control or format character and prose
  (clear_input, attrs strings) no control character or bidi control, by the ADR-0026 rules. A
  refusal answers 400 with { "error", "code", "field", "allowed"? }: ledger-reason-invalid for a
  wait_reason outside the list (also the derived ones below), ledger-event-invalid for anything
  else (an unknown item_type or kind names the allowed list). One refused event refuses the batch.
  Producer tokens cannot send the server-owned item types experiment, seat and mc-item: 403
  ledger-type-reserved (exit 2) with the field.
  Response: { "ok": true, "workspaceId", "producer", "receivedAt", "accepted", "duplicates",
  "closedItem", "orphan", "intervals" }. Only an open creates an item: any other event for an item
  the ledger does not hold (never opened, or deleted by retention) is stored and counted as orphan. An event_id this producer already sent in this workspace, with the
  same body, is a duplicate: skipped, so replaying a batch changes nothing. The same event_id with a
  different body is refused 409 ledger-event-conflict (exit 3) with the field, and the batch stores
  nothing. An event for a closed item is stored and changes nothing (closedItem), except an open
  whose at is after the close, which reopens it.

  Derivation (per item, in the event's transaction). Each event is applied at
  max(at, the item's last event time, its wait start), so a late event never overlaps an earlier
  wait; a landing split moves the split items' last event time to the split.
    wait          ends the open wait (writes its interval) and opens the new one; the same reason
                  and holder continue the open wait instead (no interval).
    state, clear, close
                  end the open wait. A state means "no wait".
    unknown       (derived) an open range, deploy or owner-issue item (the types whose whole life
                  is waiting) with no wait and no event other than link for more than 10 min: the
                  whole silent gap, from its last event, is an unknown wait. Time with no wait on
                  any other type (a gate running, a landing holding the lock, an experiment) is
                  not waiting and is counted nowhere.
    land-queue    (derived split) counted as land-queue/lock-busy while the workspace has an open
                  landing item and land-queue/head-blocked while it has none; each landing open and
                  close ends the segment.
  A producer cannot send unknown or the land-queue/* reasons.

  The CLI takes one event, an array, a batch or JSON Lines. It sends ~/.purplemux/ledger-spool/
  <producer>.jsonl first, in order, then the new events, in batches under both ceilings. On a
  connection failure, no answer in 5 s, a 401/403/404 or a 5xx it appends what it could not send
  to the spool and exits 0, so a producer never fails because the ledger is down. A refused event
  (400, 413, 403 ledger-type-reserved, 409 ledger-event-conflict) moves alone to
  <producer>.rejected.jsonl and the rest of its batch is sent again, in order; a refused new event
  sets the exit code after the rest is delivered. A spool line that is not JSON stops the drain
  (the file is kept, the line number printed); a torn last line from a crash is dropped. Prints
  ok accepted=<n> duplicates=<n> drained=<n>[ rejected=<n>].

  Example, from a gate wrapper:
    purplemux ledger emit -w "$WS" --token-file ~/.purplemux/ledger-tokens/$WS/v2.json --json @- <<'JSON'
    { "event_id": "gate.sh:gate:4f2a9c1d0e3b:1793001600000:open", "at": 1793001600000,
      "item_type": "gate", "item_key": "gate:4f2a9c1d0e3b:1793001600000", "kind": "open",
      "holder": "lane-a", "attrs": { "host": "host-b", "mode": "full" } }
    JSON
    ok accepted=1 duplicates=0 drained=0

GET /api/cli/workspaces/<workspaceId>/ledger/items[?open=1&type=<item_type>&holder=<h>&limit=1..2000]
                                                       (purplemux ledger show -w WS [--open] [--type T] [--holder H] [--json])
  Read scope: the own token, a peer, a grant, the admin token. Response: { "workspaceId", "now",
  "items": [{ "workspaceId", "itemKey", "itemType", "openedAt", "closedAt" | null, "state" | null,
  "stateSince" | null, "waitReason" | null, "waitSince" | null, "holder" | null, "clearInput" | null,
  "parentKey" | null, "attrs", "lastEventAt", "lastSeq" }], "truncated" }, oldest first, at most
  limit (500 by default). waitReason reads unknown for a silent open item (see above).

GET /api/cli/workspaces/<workspaceId>/ledger/waits[?since=&until=&by=reason|holder|type|stage&type=<item_type>]
                                                       (purplemux ledger waits -w WS [--since T] [--until T] [--by B] [--type T] [--json])
  Read scope as items. since and until are Unix ms or ISO-8601; until defaults to now, since to 7
  days before until. since older than the 92-day retention limit is refused (400
  ledger-query-invalid): deleted waits must not read as no waiting. by defaults to reason; stage is build-review, land, deploy,
  people, hosts or unknown. type limits finished and open waits to one item type. Response:
  { "workspaceId", "since", "until", "now", "by", "type" | null, "rows": [{
  "key" | null (a wait with no holder), "waitedMs", "finished", "p50Ms" | null, "p90Ms" | null,
  "openItems", "openWaitedMs" }], "totals" }. waitedMs sums the finished waits, each clipped to the
  window. p50Ms and p90Ms (nearest rank) are over the full length of the waits that ended inside
  the window; null when none did. openItems counts items waiting now whose wait began before
  until; openWaitedMs is their elapsed wait, clipped to the window, and is not part of waitedMs.
  Rows are sorted by waitedMs + openWaitedMs, largest first. 400 ledger-query-invalid (exit 2)
  names a bad since, until, by or type.

GET  /api/cli/workspaces/<workspaceId>/ledger/experiments   (purplemux ledger experiment list -w WS [--json])
POST /api/cli/workspaces/<workspaceId>/ledger/experiments   (purplemux ledger experiment open -w WS --json @FILE)
POST /api/cli/workspaces/<workspaceId>/ledger/experiments/<id>
                                                       (purplemux ledger experiment close -w WS EXP-n --verdict keep|revert --evidence TEXT)
  Improvement experiments (ADR-HFL-03). Reads: read scope; writes: own workspace only. Open body:
  { "hypothesis": "<1..500>", "stage": build-review | land | deploy | people | hosts, "metric": "<1..64>",
  "min_days": 1..90, "max_days": min_days..90, "change_ref"?, "reason"? (a counted reason),
  "baseline"?: { "value", "window" }, "target"?, "guards"?: [{ "metric", "limit" }] (<= 8), "revert_if"? }.
  The server assigns EXP-<n>, started_at, and opens the item experiment:EXP-<n>. One active
  experiment per stage and at most two in all: 409 ledger-experiment-cap (exit 3). Close body:
  { "verdict": "keep" | "revert", "evidence": "<1..2000>" }; it closes the item (state kept or
  reverted). 409 ledger-experiment-closed for a second verdict, 404 ledger-experiment-not-found.
  400 ledger-experiment-invalid names the field.
POST /api/cli/workspaces/<workspaceId>/ledger/experiments/<id>/extend
                                                       (purplemux ledger experiment extend -w WS EXP-n --days N --evidence TEXT)
  Extend an active experiment once (ADR-HFL-03 "extend once"). Body: { "days": 1..90, "evidence": "<1..2000>" }.
  max_days grows by days, at most to 90 (409 ledger-experiment-cap, field days). A second extension is 409
  ledger-experiment-extended; a closed experiment is 409 ledger-experiment-closed. The item gains a server state
  event "extended". The experiment carries "extendedAt", "extensionDays" and "extensionEvidence" (null until extended). Response: { "experiment" } (201 on open), or
  { "workspaceId", "experiments": [...] } for the list.

Retention: a daily job (10 min after boot, then every 24 h) rolls up into rollups_daily every day
not yet rolled and every day a newly finished wait covers, then deletes events and intervals older
than 92 days, tab events and tab turns older than 30 days (ADR-0035), items closed before then, and rollups older
than 400 days, in chunks of 5,000 rows. A store failure answers 500 ledger-store-failed (exit 1).

## Event digest (ADR-0035)

Every event bound for a tab gets one wake class and a row in tab_events (ledger.sqlite, 30 days):
  urgent  typed at once: DONE, BLOCKED, NEEDS-DECISION, READY-TO-MERGE and any other end line but
          CHECKPOINTED; needs-input, off-scope, thrash, api-error, usage-limit, inactive, stalled,
          model-drift; a background job's report to the tab that registered it; Mission Control,
          resume, watch and deploy notices; red main, ROTATE, block-severity flags and alarms; a tab
          send that is not a copy.
  digest  held for the tab's next digest: CHECKPOINTED, turn-ended, ready-for-review,
          idle-no-end-line, long-wait, stuck, probe-failed, a job's report to another tab, the first
          idle heartbeat, notes, warn flags and ledger alarms, and a tab send to a tab that is only a
          copy (on the header's cc list, "X -> Y (cc ORCH): ...", and not a "->" recipient) or that
          says "no reply needed"; it stays urgent when a line or the text after the header starts
          with DONE:, BLOCKED:, NEEDS-DECISION: or READY-TO-MERGE:, or it relays an owner answer
          verbatim.
  log     recorded only: heartbeats after the first of an idle episode, and a duplicate (the same tab,
          kind and text as an event of the last 15 min that is still undelivered; a delivered copy
          never suppresses a later one). Urgent events keep only the 60 s episode filter: an
          identical end line after a fix round is a new decision.
A digest is one message, "DIGEST <n> since <time>", a line per event while it fits in 2 KB, then
the pointer to "purplemux events show". It is typed only while the tab sits at its prompt (idle,
ready for review, or waiting on its own background work; never halted, never mid-turn, re-checked
inside the dispatch lock), only when 15 min have passed since its last digest or 20 events wait, and
never within 5 s of another delivery to the tab. A tab whose oldest held event is an hour old is
reported to the human once (a flag alert). Delivery never depends on a ledger write: a ledger that
cannot be opened or written types every non-log event at once, as before.
Inbox notices keep their own delivery (ADR-0012) and are recorded when typed.

POST /api/cli/tabs/<tabId>/send for a digest-class message holds it instead of typing it and answers
  { "status": "queued" | "sent" (in a digest that went out at once) | "logged" (a duplicate),
    "submitted": boolean, "wakeClass", "duplicate" }; a tab with no live session answers 409
  agent-not-ready / session-not-running as any send does. Any other message is typed as before.

GET /api/cli/workspaces/<workspaceId>/events?tab=&since=&limit=   (purplemux events show -w WS [TAB] [--since T] [--limit N] [--json])
  Read scope. since: an age (90s, 15m, 1h, 7d), Unix ms or ISO-8601, default 1h; limit 1..5000,
  default 500 (the newest kept). Response: { "workspaceId", "tabId" | null, "since", "now", "truncated",
  "events": [{ "seq", "workspaceId", "tabId" (the recipient), "at", "class", "kind", "text",
  "sourceTabId" | null (the worker a nudge is about), "sourceTabName" | null, "rule" | null (a flag's
  rule or an alarm's reason), "deliveredAt" | null, "digestId" | null }] }, oldest first. A digest event's deliveredAt is its digest's. The log
  survives a restart: a rotated or restarted tab reads what it was sent here. The CLI prints each
  event whole for one TAB (the digest's pointer) and one line each for the workspace.

GET /api/cli/workspaces/<workspaceId>/events/wakes?since=&until=&by=window|day
                                                       (purplemux events wakes -w WS [--since T] [--until T] [--by-day] [--json])
  Read scope; default the last 24 h. A wake is one delivery in the window: an event delivered on
  its own (urgent, a recorded inbox notice or tab send) or a digest, counted once. Response:
  { "workspaceId", "since", "until", "by", "hasEvents", "rows": [{ "tabId", "day" | null, "wakes",
  "digests", "urgent" (delivered on their own), "logged" }] }. hasEvents false: the workspace has no
  tab event at all, so zero wakes is no record, not a quiet seat. 400 ledger-query-invalid names a bad
  since, until or by.

GET /api/cli/workspaces/<workspaceId>/effects?days=N   (purplemux effects show [-w WS] [--days N] [--json])
  Read scope; N 1..30, default 7 (400 ledger-query-invalid otherwise). Per component, what came next (story 15).
  fired: tab_events rows recorded in the window, any class; a firing dropped before the router (the 60 s episode
  filter) or routed to the board or phone only is not recorded. delivered: those of class urgent or digest delivered
  in the window, in units: an urgent paste, or a digest counted once per component it carried (inDigest counts
  those; every event of a digest takes the digest's outcome). delivered 0 means the component reached no tab, not
  that it never fired. followed: the recipient's next turn, from tab_turns, started within 30 s of the paste
  (nextTurnBoundMs) and made an acting tool call (edit, write or shell: Claude's PostToolUse matcher, Grok and Codex
  tool names filtered to the same class). It is a count of what followed, not of what the delivery caused. The turn
  is the one running at the paste or the first after it: one that started more than 5 s before the paste is midTurn;
  one that started past the bound, or none by the bound, is noTurn (judged, not followed); a turn still running in
  the server is pending, as is a paste younger than the bound; a tab gone with no turn is closed; a turn whose start
  or tool calls were not recorded, or a tab with no turn recorded in the window, is unmeasured. judged = delivered
  less midTurn, pending, closed and unmeasured. candidate: true when at least 10 (candidateMinObserved) deliveries
  had an observed turn (judged less noTurn) and none followed, false when one followed, null (not measured)
  otherwise, with candidateReason saying why: a candidate never rests on absence, so noTurn and delivered 0 count
  toward none. Per-probe effect is not measured; counts are per
  firing kind. Response: { "workspaceId", "requestedSince", "until", "since" (clamped to measuredSince; null:
  nothing measured), "measuredSince" (the first recorded turn) | null, "nextTurnBoundMs", "candidateMinObserved",
  "source", "rows": [{ "component" (a nudge kind, "stalled", "probe-failed", "flag:<anomaly>", "alarm:<wait reason>"
  with a derived reason folded into its parent, a notice kind, "flow:<rule>", "fleet:<flag>"), "family" (nudge |
  probe | flag | notice | phone | other), "fired", "delivered", "inDigest", "followed", "judged", "noTurn",
  "midTurn", "pending", "closed", "unmeasured", "candidate", "candidateReason", "notMeasured" }] }. Every component the code can send
  is listed, so one that reached no tab shows 0. A row with notMeasured (a reason) carries null counts, never 0: a
  phone-only flag rule, a flag delivered before its rule was recorded, or a window before the first recorded turn.

## Board: the constraint finder (ADR-0034)

GET /api/cli/workspaces/<workspaceId>/board[?mine=1]   (purplemux board show -w WS [--json|--line|--mine])
GET /api/mission-control/board[?workspaceId=all|WS]    (human session; all answers { "boards": [...] })
  Read scope on WS. A pure finder runs every 60 s per workspace over the ledger, the flow record,
  the spend index and the pool, and caches its answer; a read before the first tick derives it.
  mine=1 keeps the stuck items the calling tab holds (by tab name or id); it needs a tab token
  (400 invalid-request otherwise). Response (times Unix ms):
  { "workspaceId", "generatedAt", "ageMs", "staleSince" | null, "stuckTotal",
    "onTrack": { "state": "on-track" | "at-risk", "goal" | null, "goalState": "set" | "none" | "unknown",
                 "itemsLeft" | null, "p50At" | null, "p90At" | null, "throughputPerDay": null | [n, n, n], "reason" | null },
    "constraint": null | { "reason", "stage", "waitingHours", "trend", "ownerSeat" | null, "clearInput" | null,
                           "basis": "critical" | "all", "items", "labels": { "reason", "stage", "trend" } },
    "needsYou": null | [{ "id", "title", "createdAt", "blocked": null | { "items", "hours", "critical" } }],
    "experiments": null | [<ledger experiment with no verdict>],
    "ownerBlocks": null | { <mc item id>: { "items", "hours", "critical" } },
    "stuck": [{ "key", "itemType", "holder" | null, "reason", "since", "clearInput" | null, "critical", "reasonLabel" }],
    "windows": [{ "window": "6h" | "24h" | "7d", "since", "until", "byReason": [row], "byStage": [row], "closed": { <type>: n } }],
    "anomalies": [{ "id", "subject", "value" | null, "unit", "threshold" | null, "judged", "breached", "window", "text", "reason" | null }],
    "unknownShare" | null, "flowLocks" | null, "pool" | null, "line",
    "inputs": { "ledger" | "flow" | "spend" | "pool": { "state": "ok" | "partial" | "stale" | "unknown", "reason" | null, "at" | null } },
    "curator": null | { "health": { "state": "up" | "down" | "unknown", "reason" | null, "since" | null, "checkedAt" | null },
                        "tasks": [{ "task", "state": "shadow" | "routing", "routingHere", "promptVersion", "shadowSince" | null,
                                    "shadowEndsAt" | null, "promotedAt" | null, "promotedPromptVersion" | null }],
                        "agreement": null | [{ "task", "calls", "compared", "agreed" }] } }
  curator (ADR-0038): health "down" means the tunnel or the model does not answer and the rules route;
  \`board show\` prints "curator down" and \`--line\` appends " · curator down".
  row: { "key", "wip", "waitingHours", "p50Hours" | null, "p90Hours" | null, "throughput", "trend" | null, "previousWaitingHours" }.
  inputs.ledger.state is "ok" when the ledger was read and holds an event for the workspace; "unknown"
  (reason "ledger unreadable" or "the ledger holds no event for this workspace") means constraint,
  stuck and windows were not measured and every anomaly is null: an empty list then is not "nothing
  stuck". spend is "partial" when the index is ready but reports an error (the reason).
  onTrack.goal is null until a goal is set (board goal set); onTrack.state is then "at-risk", reason
  "no goal set". With a goal: itemsLeft = goal keys the ledger does not hold closed; throughputPerDay
  = closes of the goal keys' item types in each of the last 3 days; p50At / p90At from an exact
  bootstrap over those days; no close in 3 days is no forecast (reason says so), never a date.
  needsYou[].blocked: open ledger items waiting "owner" whose link (parent) is mc-item:<id>, their
  summed waiting hours and whether any is critical; null when nothing links, or when the ledger is
  not measured (then inputs.ledger.reason says why). goalState "unknown": the goal file could not be
  read (reason "goal not measured: ..."), never "no goal set".
  staleSince is generatedAt when the answer is older than 120 s (two ticks); treat it as stale.
  --line then ends with "stale since <time>" (AEDT/AEST).
  The constraint is the reason with the most waiting hours in the last 24 h (finished waits clipped
  to the window plus open waits' elapsed time) on critical items, else on all items. An item is
  critical when it, its parent, or the slice its own key names (range:<lane>:<key12> -> slice:<lane>)
  carries attrs.critical. trend: up / down beyond 20% of the previous window, else flat; new when
  the previous window measured nothing; unknown when the ledger's history starts after the previous
  window began. ownerSeat and clearInput are weighted by open waiting hours (ties by name). stage is
  build-review, land, deploy, people, hosts or unknown. A missing input is "unknown", never 0.
  Anomalies (ids): re-gates (gates in 24 h on a tree a same-or-wider gate already passed; close
  state "pass"; attrs.mode reused never counts; threshold 0), rework-rate (24 h; 10%; flagged from 10
  closed ranges), context-per-call (seat attrs.contextTokens over attrs.rotateAtTokens, default
  300,000), wakes-per-hour (deliveries per tab in 6 h, one per digest; 6/h), unknown-share (range,
  deploy, owner-issue, 24 h; 5%), producer-silence (open slice/gate/review/landing items with no wait,
  one per (producer of the last event, item type), subject "<producer>/<type>", "<item> silent for <n>
  min (threshold <t> min)"; threshold max(10
  min, 2 x the type's 7-day p90 lifetime), unknown under 20 closed), cost-per-landed-item (spend over
  the last 7 UTC days / ranges closed landed over the same days, from close events; never flagged),
  cache-read-per-landed-item (cache-read tokens / the same landed ranges, 7 d; never flagged),
  owner-found-defects (owner-issue items raised in 7 d / 7, unit "a day"; raised = attrs.raisedAt in
  epoch ms, never openedAt; null with "no owner-issue item in the ledger", "owner-issue producer
  silent" (no event received from the newest item's producer in 24 h), "window not covered" (that
  producer first received under 7 d ago and no item raised or opened before the window), "owner-issue
  raised time missing" (an item opened in the window, or still open, has no raisedAt, or no owner-issue
  item in the workspace carries one) or "owner-issue raised time unreadable"; never flagged).
  labels and reasonLabel are the owner's words for the tokens (src/lib/constraint-labels.ts); line and
  the text form use only them. stuck is the 50 oldest waits, capped after the mine filter;
  stuckTotal is how many matched (the text form prints "50 of N").
  Each breached anomaly is a flag alert (ADR-0032) with source "ledger", rule = id, sent to the
  workspace's orchestrator. An answer older than 120 s, or with the ledger unknown, neither raises
  nor clears. judged is false when the value or threshold is null or the measure never flags; an
  anomaly that cannot be judged keeps its raised flag.

## Curator (ADR-0038)

gemma4:26b on host-b's Ollama, reached through the user unit purplemux-curator-tunnel
(127.0.0.1:11435 -> host-b-lan 127.0.0.1:11434). It classifies harness text; it never decides,
answers or writes. One call at a time, 30 s timeout; a call queued over 10 min drops to the rules;
after a down result the queue backs off 30 s doubling to 5 min; inputs keep their last 6,000 tokens
(the cut is logged). Every call is a tab_events row, class log, kind curator, text the JSON record
{ task, model, promptVersion, sourceId | null, outcome, label | null, rulesLabel, span | null,
withheld?, spanFound, latencyMs | null, waitedMs, cutTokens, promptTokens | null, source }; a span
from a credential-like text is withheld, and no raw reply is stored. A promptVersion is
<base>-<8 hex of model, options and template>~<8 hex of the served digest and (matcher) the order set>:
any prompt edit, re-pull of the tag or order edit is a new version, with its own clock and evidence;
with no digest known, calls wait for a probe, routing reads shadow and promote refuses.
Tasks: classify-owner-message (standing-order, product-rule, answer, status-ping, one-off),
flag-owner-question (an unmarked turn ending whose last 3 lines hold a '?'), match-standing-order
(SO-n or not-covered; also every MC ask whose review needs approval or decision), reshape-question
(a refused question draft reworded; label reshaped | not-preserved | invalid and the draft's sha256,
never its text). Each is shadow (logged, nothing routes) until promoted.

Routing (story 23, ADR-0042). Only a curator label (never the rules') of the version the task was
promoted on routes, and only in a workspace in curator.routing.workspaces; elsewhere the call record
is the log. An owner message labelled standing-order is filed as SO-n (active at once) with one
keep-or-strike MC item (curator-so-<n>, format 2 confirm, class bookkeeping, default keep), only when
no active workspace or fleet order says the same (else already-filed SO-k) and the item can open (an
orchestrator with a bound run; else not-filed). The curator-so- item prefix is the server's: an
event that opens or revises one from anyone else is 400 invalid-request. Strike strikes the order
only when it is that workspace's order and its source names the curator and the item's message; product-rule is appended to ~/.purplemux/workspaces/<ws>/spec-queue.md under its
message id; answer adds a suggested link (suggestedAnswers on the item, never an answer) to the latest
open item awaiting the owner; status-ping and one-off are counted. A workspace in
curator.standing-order.candidates (default ws-ldhziO=v2-scrum-master) files no SO-n: once the task
routes, the label is one digest line to that tab naming the message id and span. Each decision is a
tab_events row, class log, kind curator-route: { task, sourceId, label, promptVersion, action,
target | null, reason? }, never the text. More than 2% of a week's filed orders struck sends
classify-owner-message back to shadow.

GET  /api/cli/curator                       (purplemux curator status [--json])
  Any scope: { model, health, queued, liveSince | null, rateLimitMs, kodit | null,
  koditCheck: { state: "configured", host } | { state: "not-configured", reason } (PMUX_KODIT_LOG_HOST in
  the server environment names the host whose kodit log the check reads; unset, the check does not run), evals: [...],
  tasks: [{ task, state, promptVersion, shadowSince | null (this version's first live call),
  shadowEndsAt | null, promotedAt, promotedPromptVersion, queue: { size, oldestAt },
  gate: { checks | null: [{ label, metric, threshold, measured, successes, trials, lowerBound,
  minTrials, pass }], shadow: [{ label, metric, threshold, successes, trials, pass }], refusals } }] }.
POST /api/cli/curator/eval  { task, split?: "holdout" | "train" | "all" }   (curator eval --task T [--split S] [--no-wait])
GET  /api/cli/curator/eval?task=T[&split=S]
  Any scope. POST starts or joins an evaluation and answers 202 { progress }; GET answers
  { progress | null, result | null }. The held-out result keeps per-class counts only; train and
  all keep per-row id, gold, predicted, outcome and latency (never text) of training ids only. A
  result whose calls span two served versions is refused. A result carries n,
  unresolved, agedOut (unreadable and older than 30 days), unresolvedByClass, excluded { shadow,
  disputed } and refused | null: more than 10% unresolved, overall or in a gated class, refuses
  before any model call.
POST /api/cli/curator/promote  { task, demote?: true }   (purplemux curator promote|demote --task T)
  Admin token only (403 forbidden). Promote refuses with 409 curator-gate-refused (exit 3) and every
  reason, each with its measure: each check's one-sided 95% Clopper-Pearson lower bound over the
  latest held-out evaluation of the live prompt plus its labelled shadow rows (0 errors needs 149
  trials for 0.98, 59 for 0.95, 29 for 0.90, 14 for recall 0.80); 72 h since this prompt version's
  first live call; 30 labelled shadow rows per check at or above the threshold; a usable
  evaluation; and for classify-owner-message and match-standing-order a readable owner spot check.
POST /api/cli/curator/label-queue  { task }   (purplemux curator label-queue --task T)
  Any scope. Adds the live version's unlabelled shadow calls of the last 30 days (for a
  precision-only task every predicted positive and as many predicted negatives, seeded) and answers
  { task, promptVersion, size, oldestAt, added, ids } — ids only, shuffled, never a prediction.
POST /api/cli/curator/label-import  { task, labels: [{ id, label }] }   (curator label-import --task T --file F)
  Admin token only. Every id must be queued (else 409 curator-refused, nothing written); labels go
  to the set, the queued predictions to <task>.shadow.json. match-standing-order also takes exclude.
POST /api/cli/curator/spot-check  { task, workspaceId[, commit: itemId] }   (curator spot-check open -w WS [--task T] [--run RUN])
GET  /api/cli/curator/spot-check?task=T                                     (curator spot-check show [--task T])
  Admin, or a tab of WS. POST drafts the format-2 multi question and writes nothing; the CLI posts
  it as the run's attention.opened at revision 0 with humanReview decision, then POST with commit
  records the 1-N -> id map once Mission Control holds the item. A redraw is refused (409
  curator-refused) while the task's last item stands. The matcher's opens only once its pool passes
  everything else. Options: all-right | some-wrong (numbers) | cant-judge (numbers); both lists:
  "wrong: 3,7; unsure: 12". GET reads the answer: unanswered | unreadable (reason) | answered.
  label-queue, label-import and spot-check refuse reshape-question (400 curator-task-invalid).
  curator eval --task reshape-question scores the first 100 replies over the held-out ids of
  ~/.purplemux/curator/eval/reshape-question.json (Mission Control item ids, built by
  scripts/curator/reshape-set.ts); only timeout, down and dropped are non-replies (unparsable and
  error are failed replies; a draft over 6,000 tokens is not reshapable), and more than 10
  non-replies first refuses the run. Promote needs
  that run of the live version with 100 of 100 schema-valid and preservation-clean, the judge's
  verdicts on it at >= 95% same (a missing verdict is different), 72 h since the version's first
  live mc ask --fix call, and every live reply of it clean.
GET  /api/cli/curator/reshape-pairs   (purplemux curator reshape-pairs)
  Admin token only. { runId, promptVersion, pairs: [{ id, sha, original, reshaped }] } of the last
  reshape run, from this server's memory (409 curator-refused after a restart): the judge's input on
  stdout, never written to disk.
POST /api/cli/curator/judge-import  { runId, verdicts: [{ id, sha, verdict: "same" | "different" }], judge? }
  (purplemux curator judge-import --file F [--judge NAME]) Admin token only, the only writer of the
  verdict file. Every id must be a replied row of that run with its sha256 (else 409, nothing written).
GET  /api/cli/curator/message?workspaceId=WS&entryId=ID   (purplemux curator message -w WS ID)
  A tab of WS, or admin. One owner message by its history id: { workspaceId, entryId, sentAt, message };
  a credential-shaped message is refused (409 curator-refused), never shown.
GET  /api/cli/owner/messages?workspaceId=WS[&since=ISO]   (purplemux owner messages -w WS [--since ISO])
  A tab of WS, or admin. The owner's prompts, oldest first: { workspaceId, since, messages: [{ id, sentAt, tabId,
  message, withheld }] }. tabId is null when the sender named no tab; a re-send keeps its first id and takes the new
  sentAt; a credential-shaped message has message null and withheld true. The history keeps the last 500.

## Board goal (ADR-0034 §10)

GET|PUT|DELETE /api/cli/workspaces/<workspaceId>/board-goal
  (purplemux board goal set -w WS --items KEY,KEY --label TEXT | board goal show|clear -w WS)
  GET: read scope; { "workspaceId", "goal": null | { "label", "items", "setAt", "setBy" } }.
  PUT { "label": "<1..120>", "items": ["<type>:<key>", ... 1..500] }: the workspace's own token only
  (403 otherwise; an admin token is not a workspace). 400 invalid-request lists every defect
  ("items[0]: saw \"story-3\", expected <type>:<key> ..."). DELETE clears. PUT and DELETE drop the
  finder's cached answer and answer { "workspaceId", "goal" | "cleared", "onTrack" } derived at once.

## Pulse (ADR-0034 §9)

GET /api/cli/workspaces/<workspaceId>/pulse          (purplemux board pulse -w WS [--json])
GET /api/mission-control/pulse[?workspaceId=all|WS]  (human session; all answers { "pulses": [...] })
  Read scope on WS. Hourly movement over the last 48 h, cached 60 s per workspace. Response:
  { "workspaceId", "generatedAt", "staleSince" | null, "scope": { "basis": "epic" | "directories", "epics": [...] },
    "hours": null | [{ "start", "total", "bySource": { <source>: n }, "gatesPassed", "gatesFailed" } x 48],
    "sources": [{ "id", "label", "state": "ok" | "unknown", "reason" | null, "count" | null, "lastAt" | null, "from": [...],
                  "sharedWith": null | [<workspace name>] }],
    "stall": { "state": "stalled" | "moving" | "steady" | "idle" | "not-measured", "reason", "lastMovementAt" | null,
               "hoursSinceMovement" | null, "lastHour" | null, "medianPerHour" | null,
               "oldestStuck": null | { "kind": "ledger-item" | "agent-tab" | "mc-item", "id", "label", "since" } },
    "wip": { "count" | null, "basis": "ledger" | "agent-tabs" | "none", "basisReason",
             "sources": { "ledger": "measured" | "no-events" | "unreadable", "agentTabs" | "missionControl": "measured" | "unreadable" | "not-used" } },
    "priority": { "text", "basis": "constraint" | "stuck-critical" | "none" | "unknown", "needsYou" | null } }
  Scope: every event belongs to one workspace. A workspace holding an epic:<slug> lease counts that
  epic's _output/<slug> gate logs and review records, the repositories its status.yaml names with an
  integration_branch (that exact branch and each story's branch, stories[].branch else story/<key>),
  and every directory whose .v2/status.yaml names the epic (main, gate logs, receipts, landings).
  Where two leased epics share a repository, a commit counts for one epic only: the one whose story
  branches alone hold it; any other commit both reach is a commits source with sharedWith set. Without a lease: its own directories, minus what
  another workspace's epic covers; a directory another workspace lists too is a source with
  sharedWith set, shown after the six and never counted in hours or stall.
  Sources (in order): ledger (open, clear, close on range, slice, gate, review, landing, deploy),
  commits (the scope's refs), gates (gate.sh logs: VERDICT word VALID with EXIT=0 passes, RED fails,
  VOID/REFUSED/KILLED/STOPPED are not finished; v2 logs: the GATE PASS|FAIL line naming the file),
  reviews (v2 receipts and every _output/<epic>/reviews/*-out.md), landed (.v2/landings.log LANDED
  lines), answers (Mission Control answers). Each read has a 10 s deadline ("read timed out"). Reads
  on an sshfs mount (_output) run at most 2 at a time; a mount that does not answer within 5 s reads
  "<mount> not answering since <time>" until a probe stat of it returns. A
  source that cannot be read is "unknown" with count null, never 0, and adds nothing to the bars;
  hours is null when no source is read.
  stall: stalled when wip.count > 0 and nothing moved for 2 h (names the oldest counted item: an
  MC item, a tab waiting for input, or a ledger item); moving when the last 60 min is above 0 and
  at or above the median of the active hours (any event) among the 168 complete hours before the
  current one (stall.medianPerHour, stall.activeHours); idle when wip.count is
  0; steady otherwise; not-measured with no basis or when no file-born source (commits, gates,
  reviews, landed) was read. The reason names every source not measured.
  wip: the ledger's open range, slice, gate, review, landing and deploy items once the ledger holds
  an event on one of those types for the workspace in 7 days; else busy or needs-input agent tabs (the orchestrator
  only while it waits for the owner: a pane prompt or a NEEDS-DECISION/BLOCKED turn end) plus open Mission Control
  items; else none.
  priority: the constraint with its owner and clear input; else the oldest stuck critical item;
  with the needs-you count. staleSince: the finder answer it rests on is older than 120 s.

## Context lifecycle (ADR-0036)

A seat is an agent tab created with a handoff file: POST /api/cli/tabs with "handoff": "/abs/path.md"
and optionally "rotateAt": <50000..900000> | "off"   (purplemux tab create ... --handoff PATH [--rotate-at N|off]).
The path is absolute (the CLI resolves it against its cwd) and need not exist yet; a relative path,
or rotateAt without handoff, is 400 invalid-request. A remote tab (--host) is a seat too: the path
names the file on its host, read over ssh; a host that does not answer is a wait. The tab answers and lists
"handoffPath" and "rotateAt". Paths by convention: v2 seats .v2/seats/<seat>/handoff.md; other
workspaces ~/.purplemux/workspaces/<ws>/seats/<tab-name>/handoff.md. Only seats rotate.
Context: the Claude statusline's last request (input + cache writes + cache reads), per session.
Rotation: when the context reaches the seat's threshold (rotateAt, else fleet config
context.rotate-at-tokens, default 300000), or after a compaction, and the tab is at its prompt (idle,
ready for review, or waiting) with no registered tab bg job and no open background task (armed
watches survive a restart and do not count; an unreadable transcript blocks), the server types one
urgent event (kind "rotate", ADR-0035), never mid-turn and never within 5 s of another delivery:
  ROTATE: bring <path> up to date, then end your turn with HANDOFF-READY.
A turn whose last line is HANDOFF-READY (or starts "HANDOFF-READY:") gets the file checked at the
next idle with the checker below, against the request time (whole seconds). Any other turn end, or a
new submission after HANDOFF-READY, asks ROTATE again with a new request time: the file is checked
only as of the seat's last turn. While a rotation is owed or under way the seat's digests are held.
Pass: the server first writes a durable checkpoint (vel-D5: git worktree, branch, head and base from
the tab's host, the handoff's fields, key seat:<ws>:<tab-name>#<attempt>) to the ledger file and reads
it back; a write that fails stops the rotation before the clear. The seat item attr checkpointRefused
names the current cause of the stop: a failed write, a host that did not answer, or a busy restart.
It is cleared once the cause is gone. checkpointRefusals counts one per rotation attempt that stopped
before the clear, not one per refusal event: a store failure and then a host down in the same attempt
count once.
Then the tab restarts --clear under the same id (ADR-0028: leases, watches, probes, notes and
reportsTo stay; a seat waiting only on watches restarts with interrupt, decided inside the restart
lock) and its first message, typed once a session newer than the restart is idle at its prompt, is
"Read <path>, then continue: <resume command>" and a RESTORE NOTICE: what the checkpoint verified,
what it covers and what it does not restore; when the worktree, branch, head or uncommitted files
differ from the checkpoint it lists the differences and asks for reconciliation before the resume
command. The seat item stays "rotating" until then, so a
server restart resumes the rotation. Fail: one message
"HANDOFF CHECK FAILED: <path>: <reasons>. Fix the file, then end your turn with HANDOFF-READY.";
a second failure raises the rotation alarm and leaves the session as it is (a later HANDOFF-READY
that passes still rotates and clears it). A rotation has one 30 min deadline from its first ROTATE
and asks ROTATE at most twice; past the deadline the digest hold is released, it counts as one
failed check, and the next rotation waits 30 min. HANDOFF-READY may end with "." or "!".
Seat item: ledger item seat:<ws>:<tab-name>, holder the tab name, written by the server: open at
create (or at the first reading after a server start), state = the rotation phase (watching,
rotate-requested, handoff-ready, rotating, rotation-alarm), attrs tabId, handoffPath, rotateAtTokens,
contextTokens and contextAt (a changed reading at most every 5 min), compactions,
compactionsSinceRotation, lastCompactAt, rotations, lastRotationAt, rotateRequestedAt,
rotationFailures, rotationAlarm; closed when the tab closes. Board anomalies (ADR-0034):
context-per-call, seat-compactions (compactionsSinceRotation, threshold 0: a compaction is a missed
rotation) and rotation-alarm (rotationFailures, threshold 1) and handoff-undelivered (a rotated seat whose first
message was dropped after 10 min, threshold 0); each breach is a ledger flag alert. While a seat is
rotating its urgent events are held too and typed after the first message.

POST /api/cli/handoff/check   (purplemux handoff check PATH [--rotate-requested-at UTC] [--now UTC] [--json])
  Any CLI scope. Body: { "text": the file, "rotateRequestedAt"?: UTC, "now"?: UTC } (UTC =
  YYYY-MM-DDTHH:MM[:SS[.ffffff]] ending in Z or +00:00; else 400 invalid-request). Response
  { "ok", "reasons": [string], "seat" | null, "updatedAt" | null, "resumeCommand" | null }. The schema:
  the title "# Handoff: <seat> · updated <UTC>" first, not older than the request nor more than 5 min
  after now; the headings ## Role (1-3 lines), ## In flight (none, or the table | item key | state |
  next action | waiting on |), ## Open questions (none, or Mission Control item ids), ## Standing rules
  (none, or "- <rule> (source: SO-<n> | DEC-<n> | ARC-<n> | lane ledger <name> <YYYY-MM-DDTHH:MM:SSZ> |
  owner message <UTC date>)", one source per rule), ## Decisions in the last 24 h, ## Do not,
  ## Resume command (one line), once each, in that order, no other; at most 12288 bytes. KR-<n>,
  C-<name> and an ORCH-<n> stamp without "lane ledger" are not sources. The CLI reads the file
  (unreadable or non-UTF-8: exit 1), prints "handoff-check: PASS <path>" (exit 0) or one
  "handoff-check: <reason>" line each (exit 1), the wording of v2's tools/handoff-check.py.

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

  Attention class and stated default (ADR-0031): attention.opened and attention.updated accept
  two optional payload fields. "class" is one of "money", "irreversible", "scope" or
  "bookkeeping". "defaultOptionId" names one of the item's options[].id; an action item has no
  options, so a default on it is refused. An unknown class or a default that names no option
  refuses the whole batch with 400, and the error names the field. A producer that cannot name
  the class omits it; money, irreversible and scope are never auto-answered. Only the producer
  sets the class: the server never guesses one, and an item without a class reads "class": null
  (shown as Unclassified). An item with a human review (humanNeed not "none") and no class is
  accepted with the lint finding "class: absent" in the events route's 200 body and on mc ask's
  stderr; it is never refused. A kind=question that holds owner steps (an owner verb starting a
  sentence or list item, such as "Click Approve", "Paste it into", "Go to", "Run this", or "Your
  steps") in its context, decision, whyNow or option text gets the lint finding "owner steps in a
  question: ..." the same way (vel-MC-ACT): answering a question closes it, and a step written
  inside it closes with it, undone, so open each owner step as its own kind=action item
  (answerType action-done, humanNeed external-action). A kind=action opened with no humanReview
  by the configured orchestrator is stamped humanNeed external-action and opens in the owner's
  list; from any other tab it stays a candidate, with the lint finding "humanReview: absent on a
  kind=action". The snapshot item carries "class" and "defaultOptionId" (null when
  absent); attention.updated replaces both under the item revision rule, and a change of either
  on an open item needs renewed review like any other question change. The snapshot also carries
  "answersByClass": [{ "day": "YYYY-MM-DD", "class": "money"|...|"unclassified",
  "by": "human"|"rule", "count": N }] for the last 7 UTC days: the days end on the UTC day of the
  snapshot's "generatedAt", today included. Rows are sparse: when "answersByClass" is present, a
  missing (day, class, by) row is a count of 0; when the field is absent, the counts are unknown.
  {"events":[{"eventId":"evt-question-2","schemaVersion":1,"workspaceId":"WS","runId":"run-1",
    "expectedRevision":0,"producerAt":1700000000003,"bindingGeneration":1,"type":"attention.opened",
    "payload":{"itemId":"question-2","kind":"question","title":"Record the release note",
      "context":"Add the rollout to the release notes","storyIds":[],
      "options":[{"id":"gradual","label":"Gradual"},{"id":"direct","label":"Direct"}],
      "recommendation":"gradual","blockingScope":"none","canContinue":true,
      "class":"bookkeeping","defaultOptionId":"gradual"}}]}

  Bookkeeping auto-answer (ADR-0031): when the admin sets fleet config
  attention.auto-answer.bookkeeping-minutes to N, the server checks once a minute for an item
  that is open, has a humanReview whose humanNeed is not "none", has "class": "bookkeeping", is
  not an action, has a "defaultOptionId" that names a current option, and whose last revision is
  at least N minutes old. It records an answer for that item with "optionIds": [defaultOptionId]
  as the actor "system:auto-answer". The answer is delivered and acknowledged like a human
  answer; the rule never resolves or cancels an item. Money, irreversible, scope, unclassified
  and default-less items are never auto-answered. A human answer or a cancel that comes first
  wins. The answer text, and the item's "autoAnswer" note, read: Auto-answered under fleet
  config attention.auto-answer.bookkeeping-minutes=N (version V) at ISO-TIME: applied the
  stated default "LABEL". The "answer.recorded" event of a rule answer carries
  "actor": "system:auto-answer". The submission IDs "auto:..." and the event IDs
  "answer:auto:..." are reserved for the rule (400 invalid-request), and a human session
  subject that starts with "system:" is refused (403 forbidden).
  Each snapshot item carries "autoAnswer": { "rule", "ruleVersion", "appliedOptionId", "at",
  "note" }, or null when no rule answered it. The snapshot carries "autoAnswered": [{ "itemId",
  "workspaceId", "runId", "title", "class", "appliedOptionId", "appliedOptionLabel", "at",
  "note", "itemState" }] for the last 7 days, newest first, at most 100 rows. An absent field
  means the server does not report it (not available), never 0 and never "no auto-answers"; an
  absent "autoAnswer" on an item reads as null.

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
  NEEDS-DECISION items (ADR-0041 §2): an attention.opened whose itemId starts with nd-<16 hex>
  while another item of that prefix is open returns 409 { "error": "an item for this
  NEEDS-DECISION line is already open: <id>", "code": "already-open", "current": <the open item> }.
  Do not open another: name the open item's id.
  One item per question (story PM-2): while the tab has one open nd- item, a reworded
  NEEDS-DECISION line revises that item (attention.updated, revision + 1); it opens no second item.
  For 24 h after the owner's answer, the same line opens nothing, before and after the ack, and
  the server sends the answer to the asker again. "The same line" ignores the class tag and
  letter case. A reworded line opens nothing while the answer is not acknowledged. A genuinely
  different question opens its own item with the marker [new]: NEEDS-DECISION: [new] [money]
  <question>? (a) ... (b) ... ([new] and the class tag in either order). Repeat that line
  unchanged while you wait. One [new] question per tab at a time: while the tab's [new] item
  is open, or answered with its answer not yet acknowledged, a [new] line opens nothing and
  changes nothing (it is held, and the orchestrator is told). A [new] line never revises an
  item. Why one: a reworded repeat of a waiting [new] line would otherwise open another item.

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

Question format v2 (ADR-0037):
  attention.opened and attention.updated carry a question. A question with "formatVersion": 2 is
  checked against the format-2 rules; one without it is v1 and is checked against the v1 rules
  above. Format-2 fields:
    "decision"           required, one line, at most 120 chars: the thing to decide
    "whyNow"             at most 200 chars; required on "kind": "question"
    "answerType"         "single" | "multi" | "confirm" | "text" | "action-done";
                         "action-done" needs "kind": "action", every other type "kind": "question"
    "options"            single and multi: 2-4; confirm: exactly 2 (omit them for Yes/No);
                         text and action-done: none. Each { "id", "label" (at most 60, one line),
                         "consequence"? (one line, at most 160), "recommended"? (at most one true on
                         single and confirm), "needsText"? (selecting it requires answer text) }
    "recommendationWhy"  at most 200 chars; required when an option is recommended. It replaces
                         "recommendation", which a format-2 question does not take
    "evidence"           at most 8 { "label" (at most 60), "url" (http or https) }, each url once
    "context"            optional CommonMark + GFM, at most 4000 chars; shown with no raw HTML,
                         collapsed beyond 12 lines, links open in a new tab
    "title" (at most 80), "storyIds", "blockingScope", "canContinue", "class", "defaultOptionId"
                         keep their v1 rules; "source" (the original draft, at most 16000 chars of
                         JSON) is set by the curator reshape
  Unknown fields are refused. The owner can always answer with text alone ("Other").
  A refusal is 400 { "code": "question-invalid", "error", "defects": [{ "eventId", "itemId",
  "field", "measured", "limit", "message" }] } listing every defect of every event, for example
  "options[2].label: 87 chars, at most 60" or "options: 1 option on answerType single, needs 2-4";
  nothing in the batch is written (CLI exit 2). At fleet config mission.question-format.min-version
  1 (the default) a v1 question is accepted and the 200 response carries "lint": [{ "eventId",
  "itemId", "findings": [defect, ...] }] for it; at 2 a new v1 question (attention.opened) is
  refused, an attention.updated that keeps a v1 item v1 is accepted with its lint, and one that
  would turn a format-2 item back into v1 is refused.
  The snapshot item carries the format-2 fields as stored, its evidence links as "evidenceLinks"
  ("evidence" stays the item's provenance), "lint" (the format-2 findings of a v1 question, [] on
  v2), "changes" (the latest attention.updated record, null when none) and, once the work-item
  ledger serves it, "blocked": { "items", "hours", "critical" } (absent until then, never 0).

  One example per answer type (the "payload" of an attention.opened):
  single:  {"itemId":"q-gate","formatVersion":2,"kind":"question","title":"Gate policy",
    "decision":"Should the landing lock reuse the pre-flight gate?","whyNow":"Re-gating costs 13 lock-hours a day.",
    "answerType":"single","options":[{"id":"reuse","label":"Reuse the pre-flight gate",
    "consequence":"The gate runs once.","recommended":true},{"id":"keep","label":"Keep re-gating"},
    {"id":"change","label":"Change something first","needsText":true}],
    "recommendationWhy":"85% of lock time re-runs a passed gate.",
    "evidence":[{"label":"Lock-hours, 7 days","url":"https://example.com/lock"}],
    "context":"The **pre-flight** gate ran on the same tree.","storyIds":["20"],"blockingScope":"story","canContinue":true}
  multi:   {"itemId":"q-batch","formatVersion":2,"kind":"question","title":"Owner decisions",
    "decision":"Which of these decisions do you approve?","whyNow":"Five stories wait on them.","answerType":"multi",
    "options":[{"id":"od-1","label":"OD-1 evaluator defines done"},{"id":"od-2","label":"OD-2 one gate"}],
    "storyIds":[],"blockingScope":"run","canContinue":true}
  confirm: {"itemId":"q-deploy","formatVersion":2,"kind":"question","title":"Deploy",
    "decision":"Deploy 0.31.0 to the live server now?","whyNow":"The dry run passed.","answerType":"confirm",
    "storyIds":[],"blockingScope":"none","canContinue":true}            (options omitted: Yes / No)
  text:    {"itemId":"q-note","formatVersion":2,"kind":"question","title":"Release note",
    "decision":"How should the release note describe the WIP cap?","whyNow":"The release is cut at 17:00.",
    "answerType":"text","storyIds":[],"blockingScope":"story","canContinue":true}
  action-done: {"itemId":"q-pixel","formatVersion":2,"kind":"action","title":"Pair the Pixel",
    "decision":"Pair your Pixel for wireless debugging.","answerType":"action-done",
    "context":"Run \`adb tcpip 5555\` once over USB.","storyIds":[],"blockingScope":"run","canContinue":false}

  Revisions keep the owner's answer: each attention.updated stores "changes": { "fromRevision",
  "toRevision", "compatible", "decision": { "from", "to" } | null, "answerType": { "from", "to" } |
  null, "options": { "added": [ids], "removed": [ids], "relabelled": [{ "id", "from", "to",
  "needsText"?: { "from", "to" } }] }, "recommended": { "from": [ids], "to": [ids] } | null,
  "recommendation": bool (recommendationWhy on v2, recommendation on v1), "whyNow": bool,
  "title": bool (v2), "context": bool, "evidence": bool, "unrecorded": [revisions] } on its event
  and on the item. A
  revision is compatible when the decision (the title on v1) and the answer type are unchanged and
  no option was removed. An answer whose expectedRevision is older than the item's revision is
  accepted when every revision between them is compatible and every selected option still
  exists; the answer then carries "appliedRevision" (the current revision) beside
  "expectedRevision", and so does its answer.recorded event. Otherwise 409 conflict with "current"
  (the item) and "changes" (the span merged; a revision with no record, written before ADR-0037,
  is listed in "unrecorded" and counts as incompatible). An answer to a format-2 item selects at
  most one option on single and confirm, and gives text when a selected option has needsText
  (400 invalid-request otherwise).

  A follow-up question (ADR-0037 amendment D2): an answer, text alone too, makes the item
  "answered", and an answered item takes no attention.updated. To ask again, open a new item with
  "followsUp": "<answered item id>" in the attention.opened payload, beside itemId and humanReview
  (it is not a question field). In the same write the store links the new item to the earlier one,
  acknowledges the earlier answer's delivery and resolves the earlier item with "Followed up by
  <new id>." (event id system:follow-up:<new id>, reserved). The new item must carry a humanReview
  whose humanNeed is not none (400 invalid-request). The 200 body carries "followedUp": { "itemId",
  "answerId", "optionIds", "optionLabels", "text", "resolved" } (a batch with two or more follow-ups
  carries "followedUps": [...] instead); read the answer there, since its paste is never sent. A
  selected option id that the earlier question no longer holds is labelled "an option no longer in
  the question", never the id.
  "resolved" is false when the earlier item was already resolved: the store writes the link only.
  Refusals write nothing: an open, candidate or cancelled target 409 with "followsUp": { "reason":
  "not-answered" } (revise an open item with attention.updated instead); another run 409
  "other-run"; a target already followed up 409 "already-followed" with "followedBy" and "tip"
  (the last item of the chain: follow that one up); another workspace 403 forbidden; an unknown id
  404; followsUp equal to the item's own id, or on attention.updated, 400 invalid-request. Every
  served item carries "followsUp": { "itemId", "title", "answer": { "optionIds", "optionLabels",
  "text", "at" } } | null and "followedBy": { "itemId", "title", "state" } | null.

POST /api/cli/mission-control/questions/check?workspaceId=WS   { "question": { ... } }
  Any valid token. The events route's question check without the write: 200 { "ok", "formatVersion",
  "minVersion", "defects", "lint", "question" (normalized, null when refused), "reshape": {
  "enabled", "reason" | null } }: enabled only where reshape-question routes in WS. With
  "followsUp", "itemId" and "runId" beside the question (a WS token only), it also answers the
  follow-up refusal the events route would give, as a defect of field "followsUp" with its "code",
  "status" and "followsUp" detail; nothing is written.

POST /api/cli/mission-control/questions/reshape?workspaceId=WS   { "question": { ... } }
  A tab of WS, or admin. The curator's reshape of a refused draft (story 23). It posts nothing. 200 {
  "outcome": "reshaped", "question" (format 2, the original in "source"), "promptVersion" } only where
  reshape-question routes; elsewhere { "outcome": "shadow", "reason" } at once, the reshape queued
  and logged. Otherwise "refused" (label not-preserved | invalid, defects), "no-reply" (reason),
  "not-reshapable" (structural defects a wording change cannot fix), "not-a-draft" or "off". A
  reshape keeps option ids, count and order, recommended, needsText, answerType, kind, class, the
  default, story ids, blocking fields and every evidence URL, and fields already within their limit.

CLI equivalents:
  purplemux mc ask -w WS --json @DRAFT [--fix]
  DRAFT is one attention.opened or attention.updated event (or { "events": [that event] }). The
  CLI checks its question, prints every defect (field: measured, limit) and exits 2 with nothing
  posted, or prints any lint and posts the event. --fix asks the curator reshape route: a
  "reshaped" draft is checked again and posted in the same command; any other outcome prints with
  the defects and exits 2. "mc" is "mission".
  purplemux mc ask -w WS --json @DRAFT --follows-up ID [--fix]
  Puts "followsUp": ID on the draft's attention.opened. A refused follow-up prints and exits 3
  (not-answered, other-run, already-followed, forbidden), 7 (unknown ID) or 2 (no human review),
  with nothing posted. On success it prints one line: follows up ID: the owner answered <labels, or
  "text only">: "<text>" (answer <id>); ID is resolved. --fix keeps the field.
  purplemux mission snapshot -w WS
  purplemux mission bootstrap -w WS
  purplemux mission events -w WS --json '{"events":[...]}'
  purplemux mission answers -w WS [--run RUN] [--all]
  purplemux mission ack -w WS --run RUN --answer ANSWER --generation N --revision N --event-id EVENT --producer-at MS
  By default answers returns only current answered items whose delivery is not acknowledged,
  including the current item revision and run binding generation. --all includes history.
  Both forms forward humanInboxPolicy so ordinary turns can review pending legacy candidates.
  Reuse the exact event ID and producer timestamp after a lost response; changing either is a conflict.

## Human coordination routes (ADR-0029 §6-§10)

The web coordination panel and the phone act through these cookie routes. A CLI token cannot call
them (401 without the human session cookie, 403 for another Origin). None of them types into a tab.
Agents use the CLI routes above; this list says what a human can do to your coordination state.

GET  /api/mission-control/coordination   gains "deploys": { ok, items: [{ id, reason, createdAt,
  restartAt, phase: "pending"|"past", by, recipients: { total, delivered, queued, held, dropped } }] }
  | { ok: false, error } — the deploy announcements of the last 24 h, newest first.
GET  /api/mission-control/coordination   "fleet": { ok, view } carries view.rotation (vel-D5): workers,
  covered, coverage, rotations, handoffRefusals, checkpointRefusals (one per rotation attempt that
  stopped before the clear, never one per refusal event), rotationTimeouts, waitToRotateTotalMs,
  waitToRotateMeanMs and seats[] (each open seat's phase, counts, checkpointRefused: the current
  cause of a stop, and waitingMs). Totals include closed seats. A null total was never written: it was
  not measured.
POST /api/mission-control/notes          { toWorkspace? | toEpic?, subject, body } → { note }
  A note from "human" (its fromLabel): admission "human", to the target workspace's orchestrator;
  toEpic resolves at send time to the live epic holder's workspace (none: 400 note-target-missing).
  Same bounds as POST /api/cli/notes; note-too-large is 400 here. A human never acks a note.
POST /api/mission-control/inbox/<id>/retry → { item }
  Re-queues a held item of any workspace once. 409 inbox-not-retryable with "reason" for a hold whose
  leading token is stranded-in-composer, transport-uncertain (either could type the line twice) or
  target-not-agent (never deliverable). Refusal-budget and 24 h holds are retried.
POST /api/mission-control/leases/break   { name, reason (1..500) } → { broken }
  The admin break transition; the lease-release audit line names by: { human: <session subject> }.
  400 invalid-request, 404 lease-not-found.

## Web-browser tabs

These endpoints only work when the tab's panelType is "web-browser" and the webview
has attached (dom-ready has fired at least once). Electron runtime required;
503 is returned in headless/remote mode. On a headless host, use the crawl container of the
repository under test, never a host-wide Chrome on localhost:9222 (docs/cookbook/browser-evidence.md).

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
