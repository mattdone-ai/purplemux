# Design check: vel-D4, one shared budget per host

Story `vel-d4-shared-budget`. Base commit `05d56b83`. Amends ADR-0039 §2-§5.

## 1. Approach

1. Each known host has one budget: CPU threads and memory. A reserved control-plane share comes off the top. The rest
   is the worker budget.
2. Every pool kind (`gate`, `build`, `mutation`, `browser`, `test-service`, `tab`) has a CPU and memory envelope. A
   held lease reserves its envelope from the worker budget of its host until release, TTL or holder close. Agent tabs
   in the layouts reserve the tab envelope. The separate `floor(threads/8)` caps go.
3. Two independent checks admit work. The ledger check compares envelopes with the configured budget and never reads
   measured use. The measured check compares the live read with the envelope, and subtracts only the reservations the
   read cannot show yet (the 60 s lag). No figure is counted twice.
4. Classes: `product` (application repair, candidate validation; the default) and `harness` (harness and optional
   jobs). A harness job holds at most `pool.harness-share-pct` (default 25 %) of a worker budget. Waiting harness
   tickets under that share keep their arrival order with product tickets, so they never starve.
5. `control-plane` is a tab class: it runs here, draws on the reserve, and is never queued or refused.
6. A queueable request that fits no host gets a ticket (lease kind `pool-queue`) with its position and the measured
   and expected figures. The waiter re-asks with the ticket. The ticket becomes a slot lease in one lease transaction.
7. `tab create --host auto` always queues. It never falls back to this host on a capacity answer.
8. The budget comes from fleet config (`pool.budget.<host>.*`, `pool.envelope.<kind>.*`, `pool.harness-share-pct`).
9. Review round 1 adds `pool.mode` (§9): `shadow`, the shipped default, admits what the budget, measured-memory and
   sustained-load checks would refuse, and logs and counts it. `enforce` refuses. The release ships shadow.

## 2. Admission state machine

```
requested --(fits host H; no earlier ticket may run on H)----------------> admitted --(release | TTL | holder closed)--> released
    |  \
    |   `--(no fit; queue asked; not too-large)--> queued --(re-ask: fits; next for H)--> admitted
    |                                                |  ^
    |                                                |  `--(re-ask: no fit; TTL renewed at half life)
    |                                                `--(no re-ask in 120 s | holder closed | pool release)--> gone
    `--(invalid | too-large | no fit and no queue asked)--> refused
```

| From | Event | To | Written in the lease lock |
|---|---|---|---|
| requested | fits host H; no ticket ahead may run on H | admitted | slot lease `pool:<H>/<kind>-<n>`, note `pool mem= threads= class=` |
| requested | no fit, `queue: true`, not too-large | queued | ticket lease `pool-queue:<kind>-<n>`, TTL 120 s, the request in the note |
| requested | no fit, no `queue` | refused | nothing (`409 pool-full` with the refusal and the figures) |
| requested | the envelope exceeds every allowed host | refused | nothing (`409 pool-full`, `too-large`) |
| queued | re-ask, fits and next for H | admitted | the ticket is released and the slot lease taken in one transaction |
| queued | re-ask, no fit | queued | the ticket TTL is renewed only when less than half of it is left |
| queued | no re-ask in 120 s, holder closed, release | (gone) | ticket pruned or swept |
| admitted | release, TTL, holder closed | released | the slot lease leaves the ledger |
| control-plane tab | any | admitted (here) | a tab lease in the reserve ledger; over the reserve is stated, not refused |

A tab start is a short admission: the tab lease (TTL 300 s) holds the envelope from placement until the tab exists in
the layout. The route releases it after the create, so the layout count takes over.

Order of the queue. A product ticket has rank 0. A harness ticket has rank 0 while its envelope fits under the harness
share on at least one allowed host, else rank 1. Inside a rank, the order is arrival (`acquiredAt`, then the name).
A request (new or ticket) may take host H only when no ticket ahead of it may run on H. There is no backfill: a small
request never takes capacity that accumulates for a larger ticket ahead of it.

## 3. Alternatives, with evidence from the code

| Option | Evidence | Verdict |
|---|---|---|
| A. Keep per-kind caps, make each smaller | `slotCapOf()` (`src/lib/pool.ts:57-63`) computes each kind's cap from the same threads with no shared term. ai-server: 8 gate + 8 build slots = 128 modelled threads on 64. Any per-kind split still sums past the host when a kind is added (mutation, browser, test-service), and it says nothing about memory. | Rejected |
| B. Measured-only reservation (openharness `superTabs/reservations.ts`: reserve against measured free memory, drop the reservation 5 min after start) | This is the model the pool has now: `unseen()` (`src/lib/pool.ts:72-73`) counts a lease only within `LOAD_LAG_MS` (60 s) of the read. The review found that it gives no headroom for a later peak: a treasury-api gate fallback reaches 30 GiB minutes after start (ADR-0039 §6, 2026-10-14). openharness drops the reservation because it compares reservations with measured free memory: holding it counted each job twice and refused a start with 7.85 GiB free. | Rejected as the only check. Kept as the measured guard, with the double count removed (below). |
| C. Server-side deferred create (store the POST, replay it when capacity frees) | The create route (`src/pages/api/cli/tabs/index.ts`, POST, about 200 lines) runs the role, WIP-cap, launch-command, Codex managed-launch and status-registration steps against the request. A replay from a timer runs in the custom-server module graph (CLAUDE.md §18), not the API-route graph that owns those steps. | Rejected. The waiter holds a ticket and re-asks; the create runs on the normal path. |
| D. Chosen: ledger against the budget + measured guard + ticket queue in the lease store | `acquireChosenLease` already runs placement inside the lease lock (`src/lib/lease-store.ts:483`). Tickets as leases reuse the lock, the TTL prune, the holder-tab sweeper and the audit. | Chosen |

How D avoids the double count that openharness hit: the ledger check is `sum(envelopes) + new ≤ worker budget`. It
compares reservations with a fixed capacity, never with measured free memory. The measured check is
`MemAvailable − (memory of leases taken within 60 s of the read) − new ≥ 4 GiB`. Older leases are not subtracted
there, because the read already shows them. Each check counts each job once.

CPU. Readings are momentary, so the hard CPU limit is the ledger: envelope threads against worker threads. That is a
CPU slot count per host, in threads. The measured CPU check refuses only a sustained overload:
`min(load1, load5) + unseen threads + envelope threads > max-load` (default: the host's threads).

Enforcement. purplemux does not launch gates or builds, so it cannot put them in a cgroup. Every admission answers
with its `envelope {threads, memGb}`. A launcher that supports limits passes them on, for example
`systemd-run --user --scope -p CPUQuota=<threads×100>% -p MemoryMax=<memGb>G` or `docker run --cpus <threads> --memory
<memGb>g`. Docker sets no limit by default.

Escalate once. A ticket writes one audit line (`lease-acquire`) and one log warning when it queues. A re-ask renews
the ticket only when less than half of its TTL is left, and the CLI prints a queued line only when the position or
the reason changes. A waiter pauses; it does not spin.

## 4. The three hardest adversarial inputs

1. **A job that exceeds its envelope at its peak.** A gate declares `--mem 8` and reaches 30 GiB. The ledger still holds
   only its envelope, so the ledger alone would admit more work. The measured check sees the overrun in `MemAvailable`
   at the next read (30 s) and refuses new work while free memory minus the new envelope is under 4 GiB. The running
   job is not stopped: that needs the launcher to enforce the envelope (§3). The refusal names both figures:
   `measured 6.0 GiB free, needs 12.0 GiB (8 GiB envelope + 4 GiB floor)`.
2. **A host that goes unreachable while it holds reservations.** The host reads `unknown`. Its leases stay in the
   store and in its ledger (the view shows them), and nothing new is placed there. A ticket that may run only there
   (a local-only tab when this host is unknown) waits. Other tickets go elsewhere. The leases end by release, TTL or
   holder close. When the host reads again, its ledger already holds them, so it is not over-filled.
3. **A burst of tab starts at once.** Twenty `tab create --host auto` calls arrive together. The layouts do not show any
   of the new tabs yet. Each call places and takes its tab lease inside the lease lock, so call k sees the k−1 tab
   leases before it. The calls fill the budgets in order. The rest get tickets with positions 1..m and the measured
   and expected figures. When a tab lease is released or a tab closes, the next re-ask of the head ticket is admitted.

Other inputs and their answers:

- The orchestrator tab of a workspace is in the control-plane ledger, not the worker ledger.
- A stored budget value that is not valid (hand-edited) keeps the default, as `pool.slots.*` does.
- A ticket for a request larger than every allowed host is refused at once (`too-large`): a ticket that can never
  be admitted would block its hosts for every request behind it.
- A pool that does not answer the first `tab create --host auto` ask (no ticket) in 2 s still creates the tab here
  (ADR-0039 §4), and logs it. That answer is not about capacity. The late answer is given back (review r1 F4, §9).
- A `--cwd` missing on the chosen remote host releases that host's tab lease and asks the pool again for this host
  only. This host is admitted or queued on its own budget. It is never a free fallback.

## 5. Acceptance criteria

1. Two kinds can no longer each reserve a host's full CPU. At the measured sizes (mdserver1 32 threads / 91 GiB,
   ai-server 64 threads / 373 GiB) the gate and build leases together never pass the worker threads (24 and 48).
2. The control-plane reserve is never given to a worker: with the worker budget full, a gate, a build and a worker
   tab are refused or queued, and a control-plane tab is admitted here on the reserve.
3. A `tab create --host auto` that fits no host returns `202 queued` with a ticket, a position and the measured and
   expected figures, and creates no tab. It does not fall back to this host.
4. A queued ticket is admitted when capacity frees: its re-ask after a release takes the slot, in arrival order.
5. A harness request holds at most its share. A waiting harness ticket under its share is admitted before later
   product tickets. Product work never loses more than the share to harness work.
6. Every refusal and every queued answer states measured against expected (`budget threads 44/48 used, needs 8`,
   `measured 6.0 GiB free, needs 12.0 GiB`, `position 2 of 3`).
7. The budget, the reserve, the envelopes and the share come from fleet config. Each key is checked when written.
8. Advisory compatibility: `pool acquire` without `--queue` answers as today (admitted or `409 pool-full`). A plain
   `tab create` (no `--host auto`) does not ask the pool. Old lease notes (`pool mem=8`) still read.
9. Each new branch has a mutation that a test kills (§7).

### Defaults (documented, from the measured hosts)

Reserve default: `max(2, ceil(25 % of threads))` threads and `max(4, ceil(15 % of memory))` GiB.

| Host | Threads | Memory | Reserve | Worker budget | Gates (8 threads) at most | Agent tabs (2 threads) at most |
|---|---|---|---|---|---|---|
| mdserver1 | 32 | 91 GiB | 8 threads, 14 GiB | 24 threads, 77 GiB | 3 | 12 |
| ai-server | 64 | 373 GiB | 16 threads, 56 GiB | 48 threads, 317 GiB | 6 | 24 |

| Kind | Envelope threads | Envelope memory (GiB) |
|---|---|---|
| gate | 8 | 8 |
| build | 8 | 8 |
| mutation | 8 | 8 |
| browser | 2 | 4 |
| test-service | 2 | 4 |
| tab | 2 | 4 |

A request's `--mem` raises the memory envelope; `--threads` sets the thread envelope. Neither host has a cgroup CPU
limit (measured). ai-server reached load 147 on 64 threads; mdserver1 runs at load 55-93 on 32 threads.

**`max-load` defaults to the host's threads, and that default is a placeholder.** The measured baseline load is 1.7
to 2.9 times the thread count, so in enforce mode this default would refuse every pooled start. The release ships
`pool.mode=shadow`. After one day the owner sets `pool.budget.<host>.max-load` per host from the would-refuse log
(`min_load + pending_threads + envelope_threads` against `max_load` on each line), then sets `pool.mode=enforce`.

## 6. Launchers that must still migrate

The pool stays advisory: a launcher that never asks is not placed and its work is not in the ledger (only in the
measured check).

| Launcher | Today | Migration |
|---|---|---|
| plain `tab create` (no `--host`) | creates the tab here, no pool | worker tabs move to `--host auto`; coordinators to `--host auto --class control-plane` |
| `engineering/skills/scripts/gate.sh` (`gate.route`, `gate.remote-repos`, `gate.slots`) | its own semaphore and routing (ADR-0039 §6) | `pool acquire --kind gate --queue --class product` |
| `remote-gate.sh` (`gate.remote-hosts`, api-slot queue) | its own host queue | `pool.gate-host.<host>` + `pool.slots.<host>.gate` |
| treasury-v2 `tools/slot.sh`, `tools/gate-remote.sh` | own slots | `pool acquire --kind gate --queue` or `--kind build --queue` |
| mutation runs (mutmut / Stryker in story workers) | run in the worker tab, unbudgeted | `pool acquire --kind mutation` |
| evaluator Chrome (ADR-0040), chrome-devtools MCP | started by the tab | `pool acquire --kind browser` |
| local-dev-stack / test containers (Postgres, LocalStack) | `docker compose up` in the tab | `pool acquire --kind test-service`, and pass the envelope to `docker --cpus --memory` |
| kodit indexing, curator evaluation, harness experiments | unbudgeted | `pool acquire --class harness` |
| `/run-tabs` worker tabs | `tab create` here | `tab create --host auto` (queues) |

## 7. Mutation record

Each mutation was applied to the final tree by a script (one at a time, exact-match replacement), the named test file
was run, and the file was restored. Round 1 re-ran all 42 on the round-1 tree (M1-M26 still killed; M7's pattern now
carries the mode). M29 first survived: its test had a clean host that also won the sort, so the test was changed to make
the shadowed host win the sort, and M29 was then killed. All 42 are killed on the round-1 tree.

| # | Branch proved | File | Mutation | Killed by (first failing test) |
|---|---|---|---|---|
| M1 | the reserve is never given to workers | `pool.ts` `fitOn` | ledger CPU check against all threads, not worker threads | pool.test: gates and builds share one CPU budget |
| M2 | every held lease reserves from the one budget | `pool.ts` `hostState` | leases not added to the ledger | pool.test: gates and builds share one CPU budget |
| M3 | a lease holds its declared peak memory | `pool.ts` `leaseEnvelope` | the kind default memory only | pool.test: a note written before vel-D4 reads as the kind envelope |
| M4 | no double count of measured memory | `pool.ts` `hostState` | every lease subtracted from the read, not only the unseen ones | pool.test: (5 tests; first: gates and builds share one CPU budget) |
| M5 | harness holds at most its share | `pool.ts` `fitOn` | the share check is off | pool.test: harness work holds at most its share |
| M6 | harness over its share ranks last | `pool.ts` `rankOf` | every ticket rank 0 | pool.test: queue order |
| M7 | an earlier ticket keeps its host | `pool.ts` `placeWork` | no ticket blocks a host | pool.test: a waiting harness ticket under its share is admitted first |
| M8 | a sustained overload refuses | `pool.ts` `fitOn` | the overload check is off | pool.test: a sustained overload refuses new work |
| M9 | a momentary spike does not refuse | `pool.ts` `hostState` | load1 in place of min(load1, load5) | pool.test: a sustained overload refuses new work; a momentary load1 spike does not |
| M10 | a control-plane tab runs here on the reserve | `pool.ts` `placeWork` | the control-plane path removed | pool.test: a control-plane tab is admitted here on the reserve |
| M11 | too-large is refused, not queued | `pool.ts` `placeWork` | the too-large refusal is off | pool.test: an envelope larger than every allowed host is refused at once |
| M12 | orchestrator tabs draw on the reserve | `pool.ts` `hostState` | orchestrator tabs counted as workers | pool.test: a control-plane tab is admitted here on the reserve |
| M13 | a local-only re-ask stays here | `pool.ts` `tabLocalOnly` | the localOnly clause removed | pool.test: a local-only re-ask is judged on this host alone |
| M14 | the refusal names the furthest check | `pool.ts` `placeWork` | the nearest check wins | pool.test: the furthest check names the refusal |
| M15 | old lease notes read as the kind envelope | `pool.ts` `leaseEnvelope` | an old note reads as 0 threads | pool.test: a note written before vel-D4 reads as the kind envelope |
| M16 | same-millisecond tickets keep distinct positions | `pool.ts` `orderQueue` | tie-break by name only | pool-service.test: a burst of 20 starts ... distinct positions |
| M17 | a ticket renews at half its TTL, not on every ask | `pool-service.ts` | renew on every re-ask | pool-service.test: a ticket is renewed at half its TTL |
| M18 | an admitted ticket leaves the queue in the same transaction | `pool-service.ts` | the ticket is not released | pool-service.test: a request that fits nowhere queues ... and is admitted |
| M19 | no `--queue`: refused as before | `pool-service.ts` | every no-fit queues | pool-service.test: a held slot counts ... pool-full |
| M20 | only the holder re-asks with a ticket | `pool-service.ts` | the holder check is off | pool-service.test: only its holder re-asks with a ticket |
| M21 | a refused tab start never falls back here | `pool-tab-placement.ts` | a refusal creates the tab here | pool-tab-placement.test: a start that fits no host is queued |
| M22 | a cwd-missing start gives its lease back | `pool-tab-placement.ts` | no release | pool-tab-placement.test: a cwd missing on the chosen host gives that start back |
| M23 | a queued start creates no tab | `tabs/index.ts` | the 202 path is off | cli-tabs-remote.test: a start that fits no host answers 202 pool-queued |
| M24 | the route releases the start lease | `tabs/index.ts` | no release in `finally` | cli-tabs-remote.test: a claude-code tab goes where the pool admits it |
| M25 | budget keys are range-checked when written | `fleet-config-http.ts` | the numeric check is off | fleet-config-pool-keys.test: the admin sets pool.budget.ai-lan.threads=64 |
| M26 | the CLI prints a queued line only on a change | `bin/cli.js` `waitInQueue` | a line on every ask | cli-tab-host.test: a queued --host auto start waits |
| M27 | shadow admits the soft checks (r1 F1) | `pool.ts` `fitOn` | shadow refuses like enforce | pool.test: shadow admits a budget refusal with the would-refuse figures |
| M28 | the default mode is shadow (r1 F1) | `pool.ts` | default enforce | pool.test: the mode reads shadow unless the fleet value is exactly enforce |
| M29 | shadow prefers a host that passes every check | `pool.ts` `placeWork` | shadowed and clean hosts sorted together | pool.test: shadow takes a host that passes every check first |
| M30 | a shadow admission is logged and counted (r1 F1, F7) | `pool-service.ts` | no record | pool-service.test: admits what enforce refuses, logs one line |
| M31 | only the orchestrator keeps control-plane (r1 F3) | `pool-service.ts` `resolvePoolClass` | any caller keeps it | pool-service.test: a worker claiming control-plane is downgraded |
| M32 | a ticket blocks only a host it fits (r1 F5) | `pool.ts` `ticketCouldRunOn` | every allowed host | pool.test: a 30-thread ticket does not block mdserver1 |
| M33 | tab starts older than the lag are in the read (r1 F6) | `pool.ts` `hostState` | every recorded start pending | pool.test: a burst of 5 tab starts within LOAD_LAG_MS counts |
| M34 | recent tab starts add pending threads (r1 F6) | `pool.ts` `hostState` | not added | pool.test: shadow admits a sustained overload ... tuning figures |
| M35 | a re-ask timeout never creates (r1 F4) | `pool-tab-placement.ts` | a re-ask timeout falls back | pool-tab-placement.test: a timeout on a re-ask with a ticket creates nothing |
| M36 | only a timeout falls back (r1 F4) | `pool-tab-placement.ts` | any first-ask error falls back | pool-tab-placement.test: a pool error on a first ask is an answer |
| M37 | a late answer is given back (r1 F4) | `pool-tab-placement.ts` | no give-back | pool-tab-placement.test: a late admission gives its start lease back |
| M38 | `pool.mode` is checked when written (r1 F1) | `fleet-config-http.ts` | no check | fleet-config-pool-keys.test: the admin sets pool.mode=shadow |
| M39 | the route records a created tab start (r1 F6) | `tabs/index.ts` | no record | cli-tabs-remote.test: a created agent tab is recorded |
| M40 | a pool timeout is 503 pool-timeout (r1 F4) | `pool-http.ts` | unmapped | cli-tabs-remote.test: a re-ask the pool does not answer in 2 s is 503 |
| M41 | the fleet view carries the counter (r1 F1) | `fleet-status-snapshot.ts` | dropped | fleet-status-snapshot.test: carries the counter when it is read |
| M42 | the panel never shows a raw mode token | `fleet-status-panel.tsx` | raw token | fleet-status-panel.test: shows the mode label, the total and each host |
| M43 | control-plane needs a verified holder (r2 N1) | `pool-service.ts` `resolvePoolClass` | the verified check dropped | pool-service.test: an unverified session asserting the orchestrator tab's identity is downgraded |

## 8. Decisions taken without a consult, and residual risk

- **Plain `tab create` does not ask the pool.** At create time nothing tells a coordinator from a worker (ADR-0039 §4:
  "no tab is a coordinator at create time"). Gating it would queue coordinators and change every existing caller.
  It is the first launcher in §6.
- **The measured CPU check ships in shadow mode** (review r1 F1, F2). Under enforce, with the measured loads, the
  placeholder `max-load` would hold every pooled start. Shadow admits and logs, so nothing stalls at release.
- **Only a first ask with no ticket that the pool does not answer in 2 s creates the tab here** (review r1 F4).
  That answer is not about capacity, and the tab create must not fail when the pool is down (ADR-0039 §4). A late
  answer is given back.
- **No cgroup enforcement.** purplemux returns the envelope; the launcher must apply it (§3).
- **The tab envelope (2 threads, 4 GiB) is an estimate**, not a measurement. Change it with `pool.envelope.tab.*`.

## 9. Review round 1 (PR #45, BLOCK) and the rulings carried out

| # | Ruling | What changed | Proved by |
|---|---|---|---|
| 1 | Add `pool.mode=shadow\|enforce`, default shadow, checked when written. Shadow admits and logs; a counter is on the pool view and the fleet view. | `fitOn` returns the no-budget, no-memory and overloaded checks as `shadowed` in shadow mode. `placeWork` prefers a host that passes every check. A shadow admission carries `wouldRefuse`. The service logs one line and counts it (`pool-runtime.ts`, on globalThis). The counter is `IPoolView.wouldRefuse`, `IFleetView.pool`, a Mission Control fleet line and a `pool show` line. Every other check still refuses. | M27-M30, M38, M41, M42 |
| 2 | Keep the thread-count default for `max-load`; document it as a placeholder tuned from the shadow log. | The would-refuse line carries `min_load`, `pending_threads`, `envelope_threads`, `envelope_mem_gib`, `max_load`, the memory figures and `agent_tabs`. The text is in §5, the API guide and ADR-0039. | pool.test: the log line carries the tuning figures |
| 3 | Honour control-plane only for a coordinator resolved server-side. | `resolvePoolClass` checks `isWorkspaceOrchestrator(caller.workspaceId, caller.tabId)`, from the caller's own identity. The admin token and a tabless caller do not count. Any other caller runs as product, and `downgrade` (with the reason) says why. This covers `tab create --host auto` and `pool acquire`. | M31 |
| 4 | Fall back locally only on a timeout of a first ask with no ticket. Map the codes. A failed re-ask never creates. Give back a late answer. | `PoolTimeoutError` is the only failure that may fall back. Every other failure is `{kind: 'failed'}`, and the route answers it through `sendPoolError`: ticket-gone 409, invalid 400, full 409, timeout 503, unreadable 503 or 500. A late start lease is released. A late ticket is released when it came from a first ask. A late queued re-ask keeps the waiter's own ticket. | M35-M37, M40 |
| 5 | A ticket counts against a host only if its envelope fits that host's worker budget and the harness share. | `ticketCouldRunOn`. | M32 |
| 6 | Count tabs created within `LOAD_LAG_MS` as unseen. | The route records each created agent tab start (`recordTabStart`). `hostState` adds starts younger than the read lag to the pending threads and memory. | M33, M34, M39 |
| 7 | Covered by shadow; log the ledger's agent-tab count per host. | `agent_tabs=worker:N,control-plane:M` on every would-refuse line. | pool.test: the log line |
| 8 | Nit accepted, no change. | — | — |

Residual risk:

- The would-refuse counter and the recent tab starts are in memory and start empty when the server restarts. The
  counter states its `since`. A tab start older than the read lag is in the next read anyway.
- In shadow mode a queue still forms only on the checks that refuse in both modes (unknown host, disk, count cap,
  harness share, an earlier ticket).
- A re-ask that the pool admits after the 2 s timeout loses its place (review r2 N2). The admission takes the slot and
  releases the ticket in one transaction. The late-answer give-back then releases the slot, and the waiter gets
  `503 pool-timeout`. Its next re-ask gets `pool-ticket-gone`, and it must ask again at the back of the queue. This is
  safe, because no lease and no ticket is left behind and nothing is created. It is unfair to that one waiter, and it
  happens only when the pool takes more than 2 s to answer.
- Class control-plane needs a verified holder (review r2 N1), as the WIP-cap override does (`isOverCapCaller`). A
  workspace-token caller that asserts the orchestrator's session through `X-Pmux-Session` is unverified and runs as
  product.
