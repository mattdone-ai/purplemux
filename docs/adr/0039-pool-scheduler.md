# ADR-0039: One pool scheduler for gates, builds and tabs

## Status
Accepted (2026-11-03, epic `harness-flow-loop`, story 17; architecture ADR-HFL-09 decisions 4 and 8). The tab rule in §4 is
the ruling of the story's architect consult. Story 11 set up the hosts: the LAN aliases, `remote.hosts=ai-lan`, the
sccache backend and its sweep timer.

Amended 2026-11-08 by vel-D4 (`docs/design/vel-d4-shared-budget.md`): §3's per-kind slot caps, the tab rule "the pool
never refuses a tab" and the local fallback of `tab create --host auto` on a refusal are replaced. See "Amendment
vel-D4" below.

## Context
mdserver1 (32 threads, 91 GB) runs every Claude tab, worktree and local gate at load 34.5-42, above its thread count.
ai-server (64 threads, 373 GB) runs at load 18-28. v2 has its own remote-gate rules (`tools/slot.sh`,
`tools/gate-remote.sh`), and the engineering gate has another set (`gate.route`, `gate.remote-hosts`). Remote tabs
(ADR-0022) have had no users. Story 11's architect confirmation adds four rules. A host that does not answer is unknown:
nothing new is placed there, its leases are kept, and no lane is placed again because a read failed. Every remote read
has a hard timeout of about 5 s. A failed `ai-lan` read tries the tailnet alias once. The read covers ai-server's `/`,
`/data` and the sccache sweep timer.

## Decision
1. **Read model.** The pool's hosts are this host plus `remote.hosts`. No host is built in, so a third host joins by
   registration alone (OD-7 registers none). This host is read through `host-metrics.ts` on every call: load 1 and 5,
   `MemAvailable`, disks, plus `os.cpus()` and `os.totalmem()`. A remote host is read by one `ssh <alias> sh -s` of
   `POOL_READ_SCRIPT` every 30 s (`startPoolPoller` in `server.ts`). The read covers `nproc`, `/proc/loadavg`,
   `MemTotal`/`MemAvailable`, `df` of `/` and `/data`, `nvidia-smi`, and the state of the
   `hfl-sccache-sweep` timer and service. Each run gets the `execFile` timeout of 5 s. ADR-0022's ssh options apply,
   with no multiplexing. The sweep is read with `systemctl --user show -p LoadState,ActiveState,UnitFileState,Result`
   and served as `active`, `stopped` (installed but stopped or disabled), `failed` or `not-installed` (timer unit not
   found); `is-failed` printed `inactive` for both a stopped and an absent unit (review r2 F6). If the alias fails,
   `pool.fallback.<alias>` is tried once. A host whose read fails, or whose
   answer is malformed, is `unknown` until its retry 30 s later. A known read older than 90 s also counts as unknown. An
   unknown host carries no metrics, so it is never read as zero. A snapshot never waits on ssh.
2. **Slots are leases.** `pool acquire --kind gate|build|tab --mem <GB> --ttl <d>` takes a `pool` kind lease named
   `pool:<host>/<kind>-<n>` from the ADR-0011 store. The default TTL is 60 m and the maximum 24 h. The lease is bound to
   its tab, and its note is `pool mem=<GB>`. It ends on release, at its TTL, or when its holder tab closes (the
   existing sweeper). `acquireChosenLease` runs the placement and picks the lowest free slot number inside the lease
   lock, so two callers never take one slot. The reads and fleet values are taken before the lock: no ssh runs under
   it. A held slot counts as used. A tab slot in use is an agent tab on that host, taken from the layouts, or a
   tab-kind lease.
3. **Placement** (`placeWork`, pure, table-tested):
   - Unknown hosts are skipped, and so is a host that answered only through `pool.fallback.<alias>`: it stays in the
     view with its metrics, `via` and the served reason "answers only through <fallback>; <alias> failed", but it is
     not placeable (review r2 F2). Its remote tabs and gates would be driven through the alias that failed.
   - A gate or build needs a free slot, `/` under 85 % (the engineering gate's own refusal line) and `memGb` + 4 GiB
     free. It goes to the lowest projected load per thread, then the most free memory.
   - The pool never refuses a tab (review r2 F3): tab admission is the per-workspace WIP cap (ADR-0027). A local-only
     tab is placed here whatever this host reads. The tab slots only steer a claude-code tab between hosts: it goes to
     the placeable host with a free tab slot, the memory and the most free memory, else here.
   - A tie stays on this host.
   - "Projected" adds what the read cannot show yet. Each gate or build leased within 60 s of the read (load1 is a
     1-minute average) adds 8 threads of load and its memory.
   - A gate or build refusal is `pool-full` with `no-known-host`, `no-free-slot`, `no-memory` or `disk-full`, and the
     counts it saw.
   - Default caps are threads / 8 for gates and builds and total memory / 8 GiB for tabs. `pool.slots.<host>.<kind>`
     (0..64) overrides a cap. Measured 2026-11-03: mdserver1's default tab cap is 11 against 21 live agent tabs, so a
     `--host auto` claude-code tab chooses ai-server whenever ai-server has the memory headroom.
4. **Tabs (consult ruling).** Only a `claude-code` tab with no role may be placed remote. `codex-cli` and `grok-cli`
   cannot run remote (ADR-0022 §13). A role (evaluator, ADR-0040) runs here. A host read only through its fallback
   alias takes no tab (§3). A coordinator is never a remote tab
   (§20): no tab is a coordinator at create time, a coordinator tab is created without `--host`, and designation
   refuses a remote tab before any runtime proof (`orchestration-recovery.test.ts`).

   `tab create --host auto` asks this placement with no lease (the new tab counts itself in the layout). It then runs
   the same checks as `--host H`, and the answer carries `placement {host, local, reason, fallback}`. The pool never
   fails a create. No answer in 2 s, a refusal, or a `--cwd` missing on the chosen host creates the tab here, and the
   fallback is logged. A `--cwd` probe that fails over ssh names the host and the error, never "not a directory", and a
   `--cwd` the placement proved is not probed a second time (review r2 F4). `remote.hosts` may not name a host `auto`.
5. **Client rule.** The CLI waits 2 s for `pool acquire`. With no answer it exits 6 (`pool-timeout`). The caller then
   does what it does today without the pool: a lane falls back to its local slots and logs it. A repository in
   `gate.no-local-fallback` never runs here on any pool answer (see §6). A lease that a late answer took expires at its
   TTL. A gate passes `--ttl` at least its own gate timeout, or renews the lease while it runs: an expired slot is
   free to the next caller while the gate still runs.
6. **The engineering gate's keys map onto the pool** (migration; gate.sh and remote-gate.sh are outside this
   repository and do not change in this story). Each key, as gate.sh reads it today (`gate.sh` lines 534 and 577-580,
   `remote-gate.sh` lines 55-64, 113 and 150-166):
   - `gate.route`: `remote` makes gate.sh ask `pool acquire --kind gate` for a repository in `gate.remote-repos`.
     `local` (or a repository not in `gate.remote-repos`) keeps the gate here, without the pool.
   - `gate.remote-repos`: unchanged. It names the repositories whose gates the pool places.
   - `gate.no-local-fallback` (default `treasury-api treasury-event-consumer`; two 30 GiB fallbacks took mdserver1 to
     17 GiB free on 2026-10-14): **for these repositories no pool answer means a local run.** A local placement,
     `pool-timeout` and `pool-full` are handled exactly as today: the gate queues on the gate host, or ends
     `REFUSED-REMOTE`, never runs here.
   - A remote answer runs `remote-gate.sh` with `ORCH_GATEHOST_HOST=<gateHost>`: that pin names the container
     directly and needs no `gate.remote-hosts` entry (`GATE_HOST` resolves only against the list).
   - `gate.remote-hosts`: its entries stay until gate.sh reads the pool. Their mapping is
     `alias:slots:api-slots` on a pool host -> `pool.gate-host.<host>=<alias>` and `pool.slots.<host>.gate=<slots>`
     (`gatehost-replica:6:2` -> `pool.gate-host.ai-lan=gatehost-replica`, `pool.slots.ai-lan.gate=6`); the api-slot
     count stays in remote-gate.sh's own host queue. An entry on a host outside the pool (`gatehost-runner2`, OD-7)
     has no pool host and leaves when gate.sh reads the pool.
   - `gate.slots` (this host's gate semaphore) maps to `pool.slots.<this host>.gate`.
   - Until gate.sh reads the pool, every key keeps working as it does.
7. **Board.** `readPoolView()` (`src/lib/pool-service.ts`, `GET /api/cli/pool`) returns `IPoolView` (`src/types/pool.ts`):
   - `totals`: threads, memory, slots used/cap/free per kind, known and unknown host counts. Known hosts only.
   - `hosts[]`: per-host detail, with metrics (GPU, disks, sweep) or `null`.
8. **Per-workspace WIP cap.** `tabs.cap-per-workspace.<workspaceId>` overrides the fleet cap for that workspace
   (`capSource: workspace-config`). Both cap keys are checked when written: an integer 1..200. A stored value that is
   invalid anyway (hand-edited) serves the fleet cap under `capSource: workspace-config-invalid` with `capReason`, and is
   logged (review r2 F5). Workspace ids are
   `ws-` plus nanoid (upper case, `_`), so the fleet key grammar widens to `^[a-z][A-Za-z0-9._-]{1,63}$` (ADR-0019
   amended). Every `pool.*` key, like `tabs.*`, is written by the admin token only and checked when it is written.

## Amendment vel-D4: one shared budget per host (2026-11-08)
1. Each known host has one budget: threads and memory (`pool.budget.<host>.threads|mem-gb`, else the read), less a
   control-plane reserve (`reserve-threads`, `reserve-mem-gb`; default max(2, 25 %) threads and max(4, 15 %) GiB).
   mdserver1 (32 threads, 91 GiB) keeps 8 threads and 14 GiB; ai-server (64, 373 GiB) keeps 16 and 56.
2. Kinds are `gate`, `build`, `mutation`, `browser`, `test-service` and `tab`. Each reserves an envelope
   (`pool.envelope.<kind>.threads|mem-gb`) from the one worker budget for the life of its lease. The default caps of
   threads / 8 per kind are gone; `pool.slots.<host>.<kind>` stays as an optional count cap.
3. Admission adds, per host: the ledger check against the budget (every held lease, any age), the harness share
   (`pool.harness-share-pct`, default 25 %), the measured memory floor after the envelope, and a sustained-overload
   refusal (`min(load1, load5)` + unseen threads + envelope over `max-load`, default the host's threads).
4. Classes: `product` (default), `harness` (bounded share), and `control-plane` (a tab only, here, on the reserve,
   never queued or refused).
5. `pool acquire --queue` and `tab create --host auto` queue a start that fits no host (`pool-queue:<kind>-<n>`
   tickets, TTL 120 s, re-asked by the waiter). A tab start no longer falls back to this host on a refusal; only a
   pool that does not answer in 2 s still creates the tab here.
6. The pool stays advisory: a plain `tab create` and the launchers in the design doc §6 do not ask it yet.
7. Review round 1 (PR #45):
   - `pool.mode` is `shadow` (the default, and what any value other than `enforce` reads as) or `enforce`, and is
     checked when written. In shadow mode the `no-budget`, `no-memory` and `overloaded` checks admit, log one
     `pool would-refuse (shadow, admitted):` line (host, kind, class, min(load1, load5), pending threads, envelope,
     max-load, memory, agent tabs) and count it (`wouldRefuse` on the pool view, `pool` on the fleet view). The
     default `max-load` (the host's threads) is a placeholder: go-live runs shadow for a day, tunes
     `pool.budget.<host>.max-load` from the log, then sets `enforce`.
   - Class `control-plane` is honoured only for the workspace's enabled orchestrator tab, resolved from the caller's
     verified identity (review r2 N1, as `isOverCapCaller`). Any other caller runs as `product`, and the answer says
     why.
   - `tab create --host auto` falls back to this host only when a first ask with no ticket gets no answer in 2 s. A
     late answer is given back. Every other pool failure is an answer and creates nothing.
     Known limit (review r2 N2): a re-ask that is admitted after the 2 s timeout loses its place. The admission
     consumed the ticket, the give-back releases the slot, and the next re-ask gets `pool-ticket-gone`. It is safe
     (nothing is created or left behind) and happens only when the pool is slow.
   - A ticket holds a host back only if its envelope fits that host's worker budget (and the harness share).
   - Tab starts created within the read lag count as unseen in the measured checks.

## Consequences
One placement call replaces the remote-gate rule sets, and v2's `tools/slot.sh` and `tools/gate-remote.sh` can ask it.
mdserver1 sheds work to ai-server's idle threads by measured headroom, not by a fixed rule. A host that goes silent stops
receiving work within 30 s, and its running work keeps its leases. The pool is advisory, like every lease (C-312 class):
a caller that never asks is not placed.

## What would prove it wrong
- After 7 days in the pool, mdserver1's p90 load per thread is still above 0.8.
- The slot wait p90 is above 2 min with story 24 in place.
- A remote gate's wall time is more than 20 % above the local one at equal load.
- A placement lands on a host that was unknown, or two leases share one slot.
