# ADR-0043: Typed worker events, validated by the server, delivered as notes

## Status
Proposed (2026-11-08, story vel-D6). Design check: an internal record. Builds on ADR-0011 (leases),
ADR-0012 (the inbox's fixed lines) and ADR-0013 (notes route to the epic owner).

## Context
ADR-0013 admits a cross-workspace note only from the verified, designated source coordinator. A worker's routine
hand-off (`review-ready`, `landed`, `blocked-on`) therefore goes through its orchestrator, which reads the report,
checks the evidence by hand and sends it again: about 2 paid turns for each hand-off. The hand checks found real
defects: a missing gate, a receipt saved under the wrong name, a missing review folder. An independent review asked
for typed, scoped worker-to-worker delivery with deterministic evidence checks, and no blanket cross-workspace
terminal control.

## Decision
1. **Scope.** The workspace's verified, designated, live coordinator declares a worker tab's scope:
   `event scope set --tab TAB --epic SLUG [--story KEY] [--depends-on A,B] [--attempt N]`
   (`PUT /api/cli/worker-events/scope`). The served epic must be held as `epic:<slug>` by a live tab of the same
   workspace. `dependsOn` holds at most 16 epic slugs. `attempt` defaults to the previous attempt (else 1) and never
   goes down. Store: `~/.purplemux/event-scopes.json`, one lock, refused when malformed. A scope dies with its tab: a
   declaration drops the scopes of tabs that are confirmed closed.
2. **Schema.** `event send --type T --to-epic SLUG --json PAYLOAD` (`POST /api/cli/worker-events`). Every type
   carries `repo`, `branch`, `head`, `base` (full object ids) and `attempt`. `review-ready` is the hand-off FOR
   review: it adds `key`, `gateLog`, `reviewDir`, and an optional `receipt` (absent on a first hand-off; when given
   it must exist and is checked). `landed` adds `key`, `gateLog` and an optional `target` (the branch it landed
   in, default `main`). `blocked-on` adds `reason`, `clearInput`
   (≤ 500 characters, cleaned). An unknown field, a missing required field or a wrong form is `event-invalid`,
   which names every defect.
3. **Validation** (`src/lib/worker-event-validators.ts`). Each check is an `IEventValidator` over an injected
   `IEvidenceReader`. First, `evidence-paths`: each path resolves (symlinks followed) under the sender workspace's
   `directories` or `PMUX_EVENT_EVIDENCE_ROOTS`, and is of the right kind; nothing outside is read. Files are opened
   with `O_NOFOLLOW | O_NONBLOCK` on the resolved path and checked with `fstat`. Then all of:
   - `range` (every type): `refs/heads/<branch>` is `head`; `base` is an ancestor of `head`. For `landed` only,
     when the branch is gone (origin deletes a branch when its PR merges) or has moved on, `head` may instead be an
     ancestor of `refs/heads/<target>` or `refs/remotes/origin/<target>`. `review-ready` and `blocked-on` keep the
     exact-tip rule.
   - `gate-verdict` (review-ready, landed): the gate log's last run (from the last `START=`) says `VERDICT=VALID`
     (or `VALID (…)`) and `SETTLED=yes`, taking the last such lines, as `gate-commit-check.sh` does. A RED,
     unsettled or `AFFECTED-VALID` run is refused.
   - `gate-tree` (review-ready, landed): the last run's `GIT_TREE_END=` is `git rev-parse <head>^{tree}`.
   - `patch-id` (review-ready, landed): the server's `PMUX_EVENT_PATCH_ID_CMD` (a JSON array whose first item is an
     absolute path) over base..head prints `key`. It runs with no shell, no token and a 60 s timeout. Nothing under
     the payload's `repo` is executed: an unset or malformed variable, or a program that resolves inside the repo,
     is `event-check-unavailable`, and the refusal names the variable.
   - `review-folder` (review-ready): `range.txt`, `diff.patch`, `status.txt`, `patch-id.txt`, `record.md`, and
     `patch-id.txt` names `key`.
   - `receipt` (review-ready, only when given): named `<key>.md`; no `verdict: BLOCK` line, which belongs at
     `<key>.block.md`.

   Every command the server runs in the sender's repo (its own git reads and the patch-id command) gets
   `GIT_CONFIG_COUNT` overrides, which outrank the repo's `.git/config`, for the keys that run a program:
   `core.fsmonitor`, `core.hooksPath`, `diff.external`, `core.pager`, `core.editor`, `core.sshCommand`,
   `core.askPass`, `credential.helper`, `core.alternateRefsCommand`, `gpg.program`. Attribute drivers
   (`diff.<driver>.textconv`, `filter.<driver>.*`) cannot be pinned by name, so the patch-id script must use
   plumbing (`git diff-tree`, `git patch-id`) with `--no-ext-diff --no-textconv`. A failure is `event-refused`
   with each check's `measured` and `expected`.
4. **Fencing.** The payload's `attempt` must equal the scope's attempt, else `event-stale`. After the checks, the
   scope is read again inside the notes lock: a re-dispatch, a cleared scope or a changed epic during validation is
   `event-stale`, and a target that left the scope is `event-out-of-scope`. The same event (type, target,
   workspace, story, payload) sent again is `event-stale` and names the note and its state, unless that note
   expired unacked: then the event may be sent again.
5. **Delivery.** A validated event becomes a note with admission mode `event` and an `event` record. The notes
   service routes it like a coordinator note: to the live epic holder in the same workspace, else to the holder
   workspace's live orchestrator. The fixed inbox line, the paste preflight, ack, reminder and expiry are the notes'
   own. An event with no live recipient now is `event-no-recipient` (exit 5) and stores nothing. If the status
   note (below) fails to route, the delivery's queued line is withdrawn and nothing is stored.
   A tab on a remote host (ADR-0022), or one whose host the layout cannot say, is refused at send with
   `event-check-unavailable`: the server reads evidence on its own host only.
6. **Coordinator visibility.** `landed` and `blocked-on` are status changes: the source coordinator gets one short
   status note (type, target, key or reason), except when it is the recipient or the sender. `review-ready` is a step
   result for the task's owner: the source coordinator gets no line and reads the event with `note list`.
7. **No control.** No terminal input, no tab control, no drive grant. Nothing a worker wrote is typed into a tab.
8. **Audit.** Each delivery and each refusal is one `typed-event-delivered` or `typed-event-refused` line in the
   coordination audit log.

Exit codes (ADR-0016): `event-invalid`, `event-scope-invalid` 2; `event-refused`, `event-out-of-scope`,
`event-stale`, `event-check-unavailable` 3; `event-no-recipient` 5.

## Options considered
See the design check: extend notes (chosen), a separate event store with its own delivery (rejected: it repeats the
routing and preflight code ADR-0013 needed four review rounds to settle), the work-item ledger (rejected: a metrics
feed with no recipient).

## Consequences
- A worker's hand-off costs the orchestrator no turn for `review-ready`, and one ack for a status note.
- The checks catch mistakes, not forgery: the worker owns its evidence files.
- A remote tab (ADR-0022) keeps its evidence on another host; its events are refused at send, by its host, and it
  keeps the coordinator path.
- A deployment that wants the patch-id check sets `PMUX_EVENT_PATCH_ID_CMD` to a trusted copy of its key script
  (for example a primary checkout's `tools/patch-id.sh`, never a worker's worktree). Until then review-ready and
  landed are `event-check-unavailable`, and blocked-on still works.
- A coordinator command per dispatch (`event scope set`) is the price of a scope the worker cannot grant itself.
