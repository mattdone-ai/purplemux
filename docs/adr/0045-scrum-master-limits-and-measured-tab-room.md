# ADR-0045: The Portfolio Scrum Master sets the limits; a host's tab room is measured

## Status
Accepted (2026-11-12, ticket PMUX-SM-LIMITS, an owner-direct change). One Opus 5.5 xhigh design consult,
APPROVE-WITH-CHANGES with 14 changes; this record is the approach with those changes.
Amended by [ADR-0047](0047-psm-flow-rights.md) (14 Nov 2026, owner order): one more Scrum Master key form,
`remote.callback-url.<host>`, with a tailnet value guard.

This record amends:
- ADR-0019, the fleet-config writer rule: a third writer.
- ADR-0022: the `remote.*` keys stay admin-only, and `remote.hosts` may not name `local`.
- ADR-0027: §1, "the cap is written by the admin token only", now holds for the fleet value alone.
- ADR-0039: §3 and §4, and vel-D4 items 1, 3 and 6.

ADR-0037 is not amended: no `mission.*` rule changes. Only the text of the writer refusal that cites it changes.

## Context
The owner asked for the Scrum Master to balance the flow of tickets across the hosts, with real-time metrics, and for
the limits to be dynamic: "bounds come from free resources, never fixed counts".

Three facts stood in the way:
1. Only the admin token wrote the WIP cap and the pool keys, so the Scrum Master could not change a limit.
2. The tab limit of a host was the envelope ledger: every agent tab reserved 2 threads and 4 GiB for its whole life.
   Measured on the control host: 15 mostly idle tabs filled its 24 worker threads at a load of 0.17 per thread. The
   same ledger made the idle tabs refuse gates.
3. `pool show` had no answer to "where is room", no jobs with their work item, and no tabs by workspace. A plain
   `tab create` never asked the pool.

## Options considered
1. **A third writer class in the writer rule, with an allow-list, a reason and an audit; measured tab room;
   a room answer in the pool view.** It reuses the Scrum Master selection proof, the fleet-config history and the
   coordination audit. Tools read the value at call time (ADR-0019). Chosen.
2. **A scoped token for the Scrum Master, or the admin token.** The admin token covers every key and cannot create
   tabs (ADR-0021). A new token class is one more credential to rotate, and the audit loses the tab identity.
3. **A server timer that writes `pool.slots.<host>.tab` from the metrics.** A writer loop floods the history, lags
   one read, and races the Scrum Master's own writes. Computing the limit at the ask is exact.
4. **Keep the ledger with a smaller tab envelope.** It is still a fixed count per host.

## Decision
1. **The writer.** The Portfolio Scrum Master is a caller with all four of these properties:
   - It is verified: its tab token was bound at launch.
   - It is not the admin token.
   - It is the manager tab of the current human portfolio selection.
   - It is the live, enabled coordinator of its own workspace (`scrumMasterSnapshot`, the predicate the Scrum Master's
     reads already use).

   It writes three key forms:
   - `tabs.cap-per-workspace.<ws>`, for a workspace in its selection;
   - `pool.tab-place.<ws>`, for a workspace in its selection;
   - `pool.slots.<host>.tab`.

   Every other admin-only key stays with the admin token:
   - `pool.mode`;
   - the gate and build slot counts (a gate host's physical container count);
   - the fleet-wide cap (it changes workspaces outside the selection, ADR-0027 R2);
   - every reserve, budget, envelope and `remote.*` key.

   So no Scrum Master write can shrink the control host's reserve.
2. **The write.** A Scrum Master set or unset needs two fields:
   - `reason`, 1 to 500 characters.
   - `expectedVersion`, the version it read (`config get KEY --json`). 0 is right only for a key that was never set:
     after an unset the version keeps counting, so `config history KEY` names it. The CLI never fetches the version
     just before the write, so a write never overwrites an owner value it did not read (409).

   The proof (a file read and a tmux check) runs before the store lock. Inside the lock, the store compares the
   selection snapshot synchronously: the same actor, time, manager and workspaces, and the key's workspace still in
   the selection. If the snapshot changed, the store refuses the write (403) and writes nothing.

   The change keeps `reason` in the fleet-config history, and `by.role: portfolio-scrum-master`.
   `coordination.jsonl` records the reason, the writer and the selection snapshot. The admin token keeps its rule; it
   may give a reason.

   Every refused write is audited too (review round 1). This covers a write by a launch-verified tab, or a write
   that names a key form the Scrum Master may write. The line is `fleet-config-refused`, with:
   - the caller and the key;
   - the code and the kind: `admin-only`, `not-scrum-master`, `outside-selection`, `reason-missing`,
     `reason-invalid`, `version-missing`, `version-conflict`, `selection-changed`, `invalid` or `not-found`;
   - the reason given, and the selection the write was judged on, when the refusal had one.

   The line never carries the value. A Scrum Master set of the value a key already holds answers `changed: false`,
   writes no version, and is audited as `fleet-config-unchanged` with its reason. The admin token's refusals stay
   out, as before.
3. **The tab room.** For a known, placeable host with tab envelope `e` and the vel-D4 budget `b`:
   - free threads = min(`b.threads` − `b.reserveThreads`, `b.maxLoad`) − (min(load1, load5) + unseen work)
   - free memory = MemAvailable − unseen work − `b.reserveMemBytes`
   - room = the number of envelopes both hold, with the 4 GiB floor kept on top of the memory
   - ceiling = `pool.slots.<host>.tab`, else floor(worker memory / tab memory), at most 64
   - limit = min(used + room, ceiling)

   Memory sets the default ceiling because running out of memory kills processes, while running out of threads only
   slows them. `used` counts worker tabs and live tab-start leases; coordinator tabs run on the reserve and are not
   counted. The vel-D4 reserve stays on every host: on an exec host it is what is left for the next gate.
4. **Tab admission.** A worker tab is admitted by its room and its ceiling:
   - An explicit `pool.slots.<host>.tab` is a hard refusal in both modes (`no-free-slot`).
   - No room (`no-room`) and the default ceiling (`tab-ceiling`) refuse in `enforce` only. In `shadow` mode they admit
     and log, as the budget check they replace did.
   - Tabs rank by the most room, then the most free memory. A full tie goes to a remote host. Jobs still rank by load,
     and a tie keeps this host.
5. **Jobs.** A gate, build or other job's budget check (vel-D4 step 3) counts job leases only. Tabs reach a job
   through the measured memory and load checks, which include unseen tab starts. `budget.used` holds the job leases and
   the coordinator tabs. One function computes the room for both the admission and the view, so `slots.tab` and
   `tabRoom` never disagree.
6. **The live view.** `GET /api/cli/pool` adds these fields per host:
   - `tabRoom`: room, used, ceiling and its source, limit, free, the binding constraint, free threads and free memory;
   - `tabsByWorkspace`;
   - `jobs`: kind, lease, class, holder, item, epic, acquired at and age;
   - `memFreeBytes`, `diskRootUsedPct` and `readAgeSeconds`.

   It also adds:
   - `room.tab` and `room.gate`: a host only when that host passes every check cleanly, else null with the reason
     (`purplemux pool room`).
   - `tabPlace`: the plain creates since the server started.

   `pool acquire --item ITEM` names the work item in the slot note.

   A workspace the caller cannot read (`canAccessWorkspace`) folds into `other`. Its jobs keep only kind, class, age
   and envelope, and its queue holders are redacted. The admin token reads all.
7. **A plain `tab create`.** The workspace's `pool.tab-place.<ws>` decides what a create without `--host` does:
   - **`advise`** (the default): the tab is created here at once. The room answer is read in the background, then
     logged and counted. The advice never delays the create.
   - **`place`**: a claude-code tab with no role and no pool class asks a start that never queues. It runs on the
     answered host only when all of these hold:
     - the answer passes every check cleanly;
     - the host is in `remote.hosts`;
     - the effective cwd (`--cwd`, else the workspace's first directory) is a directory there.

     Any failure before the create creates the tab here and says why. A failure includes no answer in 2 s, a refusal, a
     shadow-only admission, an unregistered host, a missing cwd and an ssh error. Every outcome is 201: never 202,
     never 409.
   - **`here`**: nothing is asked.

   `--host local` forces this host in every mode; a coordinator uses it. `--host auto` keeps its vel-D4 behaviour.

## Consequences
- The Scrum Master sheds the control host directly. It lowers the control host's `pool.slots.<host>.tab` and sets
  `pool.tab-place.<ws>=place` for a workspace whose briefs use remote checkouts.
- By the measure, the control host often has the most tab room: an exec host's reserve and load leave little. The
  numbers in `pool show` say so, and the Scrum Master decides.
- Idle tabs no longer block gates in the budget check, so gates start where the threads are free.
- A plain create that falls back here while this host's tab room is 0 does not protect the reserve; only the WIP cap
  limits it, as before this record. `tabPlace.hereAtNoRoom` counts these creates, and the log marks each one
  `at-no-room`.

## Known limits
- **Cooperative authority** (the C-312 class). A process of the same Unix account that reads the Scrum Master pane's
  environment holds its token, as with the admin token. The bash-guard environment-listing rule and the audit are the
  controls.
- **The proof runs before the lock.** A respawn of the manager tab between the coordinator proof and the in-lock
  compare is not seen, because the selection did not change. The gap is one write, and the audit records it.
- **One config snapshot per placement.** A placement reads the config once, before the lease lock. Creates already
  past that read keep the old ceiling. A create that holds no start lease (a caller with no tab) takes no lock, so its
  overshoot is bounded only by how many such creates run at once.
- **The default ceiling is a ceiling, not a target.** A burst of creates within one read lag counts as unseen work
  through the start record, so the room shrinks with each start.

## What would prove it wrong
- After 7 days of `place` in the busiest workspaces, the control host's p90 load per thread is still above 0.8.
- A worker tab placed remote by `place` starts outside its checkout.
- A Scrum Master write lands without a reason, without the version it read, or for a workspace outside its selection.
