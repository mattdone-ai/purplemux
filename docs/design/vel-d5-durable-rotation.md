# Design check: vel-D5 — a durable checkpoint before a context rotation

Status: design check, written before code (story `vel-d5-durable-rotation`, base `05d56b83`).
Amends ADR-0036 (context lifecycle). Inputs: the independent review pinned to `05d56b83`, and the coordinator's
design inputs (harness restore from plain files; a fsynced journal with a restore notice; recovery that reads stored
state and freezes a step stuck mid-flight; no summary as the recovery mechanism).

## 1. The approach

1. The handoff check passes. The server collects the mechanical facts with one git probe on the tab's own host:
   worktree, branch, head, base ref and merge base, dirty count.
2. The server builds a checkpoint: those facts, plus the agent's own fields read from the handoff sections, which the
   checker already validated. The resume command is the intended next action, `## Open questions` the outstanding
   decision ids, `## Do not` the failed approaches, the standing-rule sources the evidence references,
   `## Decisions in the last 24 h` the rationale, `## In flight` the task rows, and the whole text is kept too.
3. The server writes the checkpoint to a new `rotation_checkpoints` table in `ledger.sqlite`. That file is the existing
   ledger (WAL, `synchronous = FULL`). Then it reads the row back and compares its SHA-256 digest. Only a matching
   read-back allows `restart --clear`. If the write fails, the rotation stops: the seat stays `handoff-ready`, the seat
   item carries `checkpointRefused`, the log has an error line, and the fleet view counts the refusal.
4. The key is `seat:<ws>:<tab-name>#<attempt>`. The task id is the seat item key. It stays the same across restarts,
   sessions and provider accounts. The attempt number comes from the table, not from the best-effort seat item.
   No session id or account is part of the key.
5. Every checkpoint row moves forward only: `written → cleared → delivering → delivered`, or ends as `abandoned`,
   `undelivered` or `delivery-unknown`. Each step is a conditional `UPDATE … WHERE status IN (…)`, so a step that
   runs again changes nothing.
6. Resume: the fresh session is idle. The server probes git again, compares the result with the checkpoint, and puts
   the handoff file and `<handoff>.checkpoint.json` on the tab's host. That host is ssh for a remote tab. Then it
   types the first message with a RESTORE NOTICE. A match says what was verified. A mismatch names each difference
   and asks for explicit reconciliation before the resume command. Both say what was NOT restored.
7. A remote seat (`--host` with `--handoff`) is allowed now. The handoff file is read over ssh, and the checkpoint
   stays on the control host. A host that does not answer is a wait. It is not a failed check, because the seat
   cannot repair a network fault.
8. Telemetry (the seat item and the counters) stays best effort. Only the checkpoint row gates the clear.

## 2. The rotation state machine, with the durable step

```
watching ──(threshold | PostCompact, canRotate)──► rotate-requested  ── ROTATE typed; rotationDueAt kept
rotate-requested ──(turn ends HANDOFF-READY)──► handoff-ready
handoff-ready ──(canRotate, checkHandoff)──┬─ fail ──► rotate-requested (message) │ rotation-alarm (2nd)
                                           └─ pass ──► CHECKPOINT
CHECKPOINT  [new]  facts = git probe (tab host) ── host silent ──► handoff-ready, refused "host did not answer"
                   put(row status=written) ; get(row) ; digest equal?
                     ├─ no / throws ──► handoff-ready, checkpointRefused, log.error, retry; the deadline bounds it
                     └─ yes ──► rotating (seat item, best effort)  ──► restart --clear
rotating   restart ok  ──► mark written→cleared ; rotations += 1 ; wait-to-rotate = restartedAt − rotationDueAt
           restart busy ──► handoff-ready (retry)       restart refused ──► mark written→abandoned ; failed check
rotating   fresh session idle ──► RESUME
RESUME [new]  probe git again ; compare with the checkpoint ; restore the handoff and the checkpoint json on the tab host
              mark cleared→delivering  (the freeze point)
              type first message (+ RESTORE NOTICE, + MISMATCH lines) ── typed ──► mark delivering→delivered ; watching
                                                                      └─ not typed ──► mark delivering→cleared (retry)
              TTL 10 min ──► mark →undelivered ; handoff-undelivered flag ; watching
server start  read the latest checkpoint row (stored state, not the seat item):
              cleared, or written with a bound session ≠ sessionBefore  ──► rotating, first message rebuilt from the row
              delivering ──► FROZEN: mark →delivery-unknown, flag handoff-undelivered, never typed again
              delivered | abandoned | undelivered | written + same session ──► the ADR-0036 seat-item resume as before
```

## 3. Alternatives, with evidence from the code

| Option | Evidence | Verdict |
|---|---|---|
| A. Make the existing seat-item `state` event durable: write `rotating`, then read the item back. | `ContextLifecycle.write` (`context-lifecycle.ts:255`) is one best-effort helper for every event: readings, compactions and phases. Ledger attrs are scalars only (`TLedgerAttrValue = string \| number \| boolean \| null`, `types/ledger.ts:13`), so lists such as decision ids would be JSON in a string. A seat item has one projection per tab, so a later `clear` reading overwrites the attrs of the rotation, and the history of attempts is lost. | Rejected. It mixes telemetry and the gate in one write. |
| B. A table inside `ledger.sqlite`, the same pattern as `tab_events`, `tab_turns` and `landings` (`ledger-store.ts:283-296`). It holds one row per attempt and is read back before the clear. | The same file and handle, already `synchronous = FULL`, already in WAL, already backed up and kept. No second database. | **Chosen.** |
| C. Also commit the checkpoint into the worker's git worktree (coordinator input 1). | A server commit on an agent branch races with the agent's own commits and goes into story landings (`story_land.py` judges tree ids). A remote worktree is out of this host's reach while ssh is down, and that is exactly when recovery needs the commit. | Partly taken. The checkpoint JSON is written as a plain file beside the handoff on the tab's host: best effort before the clear, again at resume. It is never committed. The git facts in the checkpoint make recovery from git alone possible. |
| D. Remote seat: `rsync` the handoff to the control host on HANDOFF-READY. | `runSsh` / `runSshBuffer` (`remote-host.ts:190-233`) already read remote files and run remote scripts. D63 already judges a remote tab's background jobs on its own host. | Rejected. One `cat` over ssh at check time is enough. |
| E. Threshold: lower the default to 100,000 so that it matches ADR-0036's Consequences. | `DEFAULT_ROTATE_AT_TOKENS = 300_000` (`constraint.ts:48`), and ADR-0036 §1 states "default 300,000". Only the Consequences line says "50-100k". A fresh Claude seat starts with the instruction files and the tool schemas already loaded. The workspace instruction budget alone is up to 150,000 characters (`test_instruction_budget.py`), about 35-40k tokens (an inference). | Rejected. **The ADR is updated to the real default of 300,000:** at 50-100k a seat rotates after very little work. A seat can still lower its own value with `--rotate-at`. |

## 4. The three hardest adversarial inputs

1. **The server crashes between the checkpoint write and the clear, or inside the clear.** The row is `written`.
   On start the server reads the row. If the bound session is the one before the restart, no clear ran. The ADR-0036
   resume (`handoff-ready`, check again) runs, and the next pass writes the same attempt again. That write is
   idempotent: the same digest is a no-op, and a changed file replaces a row that is still `written`. If the bound
   session changed, the clear ran. The seat is `rotating`, and the first message comes from the row even when the seat
   item write was lost. A crash after the paste and before `delivered` leaves `delivering`. That row is frozen as
   `delivery-unknown` and flagged, and it is never typed a second time.
2. **The remote host is unreachable at resume.** The git probe or the file restore fails with an ssh failure.
   Nothing is typed, because typing over that same ssh would fail too. The row stays `cleared` on the control host,
   and the next idle or tick tries again. After 10 minutes the row is `undelivered` and the board flags
   `handoff-undelivered`. The checkpoint is never lost: it is on the control host, and the fleet view names its id.
   An ssh failure when the server reads the handoff file before the clear is a wait, not a failed check, so no alarm
   counts a network fault against the seat.
3. **The worktree moved on after the checkpoint.** A background job committed, someone rebased the branch, the
   worktree was deleted, or the tab now runs in another directory. The second probe gets the checkpoint head as an
   argument and runs `git merge-base --is-ancestor`. The notice tells "moved on (an ancestor)" apart from "rewritten
   (not in its history)", and also reports a changed branch, a changed worktree, a missing directory and a changed
   dirty count. A mismatch never blocks the session. The session gets the differences and must record its
   reconciliation in the handoff before it runs the resume command. The seat item gets `checkpointMismatch`.

## 5. Acceptance criteria

1. AC1: No `restart --clear` runs unless a checkpoint row for this attempt was written and read back with an equal
   digest. A write that throws, or a read-back that is missing or differs, stops the rotation. It sets
   `checkpointRefused`, logs an error, counts `checkpointRefusals`, and is tried again inside the rotation deadline.
   A ledger telemetry write that fails still never stops a rotation.
2. AC2: The checkpoint holds the task id, the attempt, the worktree, base and head, the branch, the intended next
   action, the failed approaches, the outstanding decision ids, the evidence references, the rationale and the full
   handoff. Its key has no session id or provider account. Tools fill the facts. The agent fills only its handoff
   sections.
3. AC3: `tab create --host <alias> --handoff <path>` is accepted. A remote seat's file is read on its host. The
   checkpoint is stored on the control host and written back to the remote host at resume. An ssh failure is a wait
   and never a failed check.
4. AC4: The first message after a rotation carries a RESTORE NOTICE with the checkpoint id. It names what the
   checkpoint verified and what it does not restore. On a mismatch of worktree, branch, head or dirty count it lists
   each difference and asks for reconciliation before the resume command.
5. AC5: ADR-0036 and the API guide state 300,000 as the default, and the code is unchanged.
6. AC6: The fleet view (`IFleetView.rotation`, read by `/api/mission-control/coordination`) reports the active agent
   workers, the covered workers (seats whose rotation is on) and the coverage ratio. It reports successful rotations,
   refused handoffs, refused checkpoints and timed-out rotations. It reports the total and the mean wait-to-rotate
   (rotation due to clear), and the seats that wait now.
7. AC7: Restart tests at four workflow points: after implementation, during a long background job, after review, and
   after a merge before the deploy acknowledgement. Each point is crossed with each crash point: before the
   checkpoint, after the write, after the clear, during delivery, after delivery. In each case the right task
   resumes, the decision ids are kept, the clear runs at most once, and the first message is typed at most once.
8. AC8: A mutation proves each new branch, recorded below. `pnpm lint`, `pnpm test` and `pnpm build` pass.

## Out of scope (measured first, as the review asks)

Ordinary tabs without a handoff path still do not rotate. AC6 measures coverage first. Whether to give every worker a
default handoff path is a product decision that this measurement informs. Codex and Grok still cannot run remotely
(ADR-0022).

## Decisions made during implementation

1. **A session id that is gone since the checkpoint counts as a clear.** A restart unbinds the session
   (`markAgentLaunch`). At a server start, a row that is still `written` and a bound session that differs from
   `sessionBefore`, null included, resume as `rotating`. The risk goes in one direction. If the restart never ran
   and the old session binds again, the first message never goes, the row becomes `undelivered` after 10 min, and
   the board flags it. The rotation is then asked again. A second clear never runs. The other reading would risk
   a second clear.
2. **The dirty count leaves out `*.checkpoint.json`.** The server writes the plain copy after the checkpoint's
   probe and before the resume probe. Without this rule, every v2 seat (its handoff lives in the worktree) would
   report a false "uncommitted files N → N+1" mismatch (mutation M25).
3. **A `/clear` clears the due time.** A rotation that a human `/clear` made moot stops its wait, so the next
   rotation does not report hours of wait that it never had (M26).
4. **Telemetry tests make the seat item fail and keep the checkpoint working.** The review's finding was a lost
   phase after a durability failure and a restart. Two tests drop the seat item writes in the middle of a rotation,
   restart the server, and prove that the row alone resumes the right step.

## Review round 1 (BLOCK) and its rulings

1. **F1: a row belongs to one tab and one live rotation.** The task id is the seat name, so a closed tab and a new
   tab with the same name share a key. Three rules close the gap:
   - A row is live only when `checkpoint.tabId === seat.tabId`.
   - `onClosed` marks every unfinished row of the tab `abandoned` (`abandonTab`, a new `tab_id` column).
   - A `written` or `cleared` row that has not moved for `CHECKPOINT_LIVE_MS` is finished at the next server start
     and never resumed: `written` becomes `abandoned`, `cleared` becomes `undelivered`.
   - **The bound is 40 min:** the 30 min rotation deadline plus the 10 min first-message wait. A live rotation
     writes its row inside its deadline, clears it seconds later, and waits at most 10 min for its first message. A
     server outage longer than that is flagged as undelivered. It is not guessed at.
   - The attempt number still comes from the task's newest row, so a new tab's first rotation is the next attempt.
2. **F2: the restart hop is a wait.** `restartTab` answers `remote-host-unreachable` (503) or throws
   `RemoteKitBrokenError` before it kills anything (ADR-0028 §4). Both map to `hostUnreachable`. The row stays
   `written`, the stop is shown as a refusal, and the rotation retries inside its deadline. They are never a failed
   check (`restartRefusalOutcome`).
3. **F3: a remote seat never reads this host.** `resolveSeatPlace` uses the seat's own host when it is known.
   - A known-local seat (`host: null`) reads its live cwd.
   - A seat whose host is not known (`undefined`: an entry registered before its first layout poll) takes the host
     from its layout. When the layout cannot be read, or does not name the tab, the seat waits.
4. **F4: size, not network.** A remote handoff is read with `head -c 1048577`. Over 1 MiB, or a full buffer
   (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`), the answer is the checker-shaped refusal `size over 1048576 bytes (expected
   at most 12288, 12 KB)`, sent to the seat. It is never an ssh wait.
5. **F5: the dirty count uses an exclude pathspec** (`git status --porcelain -- ':/'
   ':(top,exclude,glob)**/*.checkpoint.json'`). The pathspec covers the whole tree from any subdirectory. It matches
   the path, not the quoted output, so a path with a space is left out too.
6. **F6: the gap after the awaits.** After the read, the git probe, the store write and the plain copy, the clear
   goes ahead only while the seat is still `handoff-ready` for the same `rotateRequestedAt`. If a turn started and
   ended in the gap, the pass stops, and the file is checked again against the new request.
7. **F7: retention.** The daily pass deletes finished rows last moved before the 92-day ledger cutoff. It never
   deletes a task's newest row, because the next attempt number is read from it.
8. **F8: coverage totals** count every seat item the ledger keeps, closed ones too. A counter that no item ever wrote
   is `null` (not measured), never 0. The per-seat rows still list open seats only.
9. **Q1: a checkpoint taken with no bound session** cannot show whether its clear ran. At a server start such a
   `written` row is frozen as `delivery-unknown`, the board flags it, and the seat is never cleared again for that
   attempt.

## Review round 2 (PASS-WITH-NITS, LOGIC CONFIRM)

- N1: the `rotation_checkpoints` schema changed in round 1 (a `tab_id` column) with no migration. That is safe
  because the table never shipped: main at `05d56b83` has no such table, so no ledger file holds the old shape.
- N3: a `git status` that fails gives the dirty count `?`, which the parser reads as not measured (`null`), never
  0. The resume notice then says `uncommitted files 0 → not measured`.

## Mutation record

Each mutation was applied to the committed tree, the named test file was run, and the file was restored. The
runners are `/tmp/.../mutate.py` for M1-M27, `mutate-d5.py` for M28-M47 and `mutate-d5-r2.py` for M48-M49. Neither runner is committed. Every
mutation listed was killed: the named test file failed.

| # | Mutation (new branch) | Killed by |
|---|---|---|
| M1 | read-back digest comparison skipped | `context-lifecycle-durable.test.ts` (read-back differs) |
| M2 | a missing read-back row accepted | durable (read-back finds no row) |
| M3 | the refusal not recorded on the seat | durable (refusal visible and counted) |
| M4 | an unreachable host counted as a failed check | durable (remote seat waits) |
| M5 | no freeze of a row stopped in `delivering` | durable (AC7 `during-delivery` × 4 points) |
| M6 | a moved session not read as a clear | durable (telemetry lost, then a restart) |
| M7 | a `delivered` row not settled quietly | durable (seat item missed the delivery) |
| M8 | no `delivering` mark before the paste | durable (AC7 `during-delivery`: typed twice) |
| M9 | the attempt always new | durable (refused, then recovered, same attempt) |
| M10 | timeouts not counted | durable (deadline ends a refused checkpoint) |
| M11 | wait-to-rotate not counted | durable (AC6 counts) |
| M12 | the resume comparison skipped | durable (worktree moved on) |
| M13 | the handoff never written back at resume | durable (handoff lost on the host) |
| M14 | `undelivered` not marked at the first-message timeout | durable (host unreachable past the TTL) |
| M15 | the seat check refuses a remote host again | `cli-tabs-remote.test.ts` |
| M16 | "moved on" and "rewritten" heads read the same | `rotation-checkpoint.test.ts` |
| M17 | the dirty count not compared | `rotation-checkpoint.test.ts`, durable |
| M18 | the mismatch notice puts the resume command first | `rotation-checkpoint.test.ts`, durable |
| M19 | coverage counts tabs whose rotation is off | `rotation-checkpoint.test.ts` |
| M20 | the notice may carry a line break | `rotation-checkpoint.test.ts` |
| M21 | an applied row takes a new body | `rotation-checkpoint-store.test.ts` |
| M22 | a step moves from any state | `rotation-checkpoint-store.test.ts` |
| M23 | an ssh failure read as a plain refusal | `seat-host-io.test.ts` |
| M24 | the handoff rewritten even when equal | `seat-host-io.test.ts` |
| M25 | the checkpoint copy counted as dirty | `rotation-checkpoint.test.ts` (real git repo) |
| M26 | a `/clear` keeps the old due time | durable (moot rotation) |
| M27 | a due seat in `watching` shows no wait | `rotation-checkpoint.test.ts` |
| M28 | F1: a row of another tab resumes | durable (close, then a new tab with the same name) |
| M29 | F1: a closed tab leaves its rows live | durable (close, then recreate: the row is abandoned) |
| M30 | F1: no age bound on a `written` or `cleared` row | durable (a cleared row older than 40 min; an aged written row) |
| M31 | Q1: a sessionless checkpoint is not frozen | durable (Q1) |
| M32 | F2: a restart that cannot reach the host is a failed check | durable F2, `status-manager-context-lifecycle.test.ts` |
| M33 | F2: host and kit refusals not mapped to a wait | durable F2 (mapping), status-manager F2 |
| M34 | F2: a thrown `RemoteKitBrokenError` is a failed check | status-manager F2 (`throws RemoteKitBrokenError`) |
| M35 | F3: the layout wins over the seat's host | `seat-host-io.test.ts` (a remote seat keeps its host) |
| M36 | F3: an unknown host falls back to local | `seat-host-io.test.ts`, status-manager F3 |
| M37 | F4: a full buffer read as an ssh failure | `seat-host-io.test.ts` (F4) |
| M38 | F4: a file over the cap is decoded | `seat-host-io.test.ts` (F4) |
| M39 | F4: a pre-check refusal loses its reason | durable F4 |
| M40 | F5: the dirty filter misses quoted paths | `rotation-checkpoint.test.ts` (a path with a space, real git) |
| M41 | F6: no re-check after the checkpoint awaits | durable F6 |
| M42 | F7: retention prunes a task's newest row | `rotation-checkpoint-store.test.ts` (F7) |
| M43 | F7: retention prunes an unfinished row | `rotation-checkpoint-store.test.ts` (F7) |
| M44 | F8: totals count open seats only | `rotation-checkpoint.test.ts` (coverage) |
| M45 | F8: an unwritten counter reads 0 | `rotation-checkpoint.test.ts` (F8) |
| M46 | F1: another tab's `written` row reused as this attempt | durable (the new tab's first rotation is attempt 2) |
| M47 | F1: a first message from another tab's row is typed | durable (a row left by a tab closed while no server ran) |
| M48 | N3: a failed `git status` counts 0 | `rotation-checkpoint.test.ts` (a corrupt index, real git) |
| M49 | N3: an unmeasured count reads "unknown" | `rotation-checkpoint.test.ts` (N3) |
