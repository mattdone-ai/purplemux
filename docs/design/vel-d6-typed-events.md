# Design check: typed, validated worker-to-worker events (vel-D6)

Status: design check before code. ADR: [ADR-0043](../adr/0043-typed-worker-events.md) records the decision.

## Problem

A cross-workspace note is admitted only from the verified, designated source coordinator
(ADR-0013, `NotesService.admissionFor`). A worker that has a routine hand-off (`review-ready`,
`landed`, `blocked-on`) therefore reports to its orchestrator. The orchestrator reads the report,
checks the evidence by hand, and sends the note again: about 2 paid turns for each hand-off. The
manual checks found real defects (a missing gate, a receipt saved under the wrong name, a missing
review folder). The checks must move into the server. They must not disappear.

## 1. The approach

1. A coordinator declares a worker tab's **scope** once per dispatch:
   `event scope set --tab TAB --epic SLUG [--story KEY] [--depends-on A,B] [--attempt N]`.
   The served epic must be an `epic:<slug>` lease held by a live tab of the same workspace (lease
   data, ADR-0011). The scope dies with the tab (tab ids are never reused).
2. A worker sends `event send --type T --to-epic SLUG --json PAYLOAD`. The target must be the
   scope's epic or one of its `dependsOn` epics, else `event-out-of-scope`.
3. The payload has a fixed, strict schema per type. Every type carries `repo`, `branch`, `head`,
   `base` and `attempt`. Unknown fields are refused. `review-ready` is the hand-off FOR review,
   so its `receipt` is optional; `landed` requires the gate log and the key.
4. Pluggable validators run over an injected `IEvidenceReader` (files, git, one command). All
   validators run, and a refusal lists every failure as `measured / expected`. The one command is
   the server's (`PMUX_EVENT_PATCH_ID_CMD`); nothing under the payload's repo is executed.
   A remote tab is refused before any evidence is read: the server reads its own host only.
5. A validated event becomes a note with the new admission mode `event`. The notes service routes
   it like a coordinator note: to the live epic holder in the same workspace, else to the holder
   workspace's live orchestrator. Inbox line, ack, reminder and expiry are the notes' own.
6. Coordinator visibility: `landed` and `blocked-on` are status changes, so the source coordinator
   gets one short status note (type, target, key; no payload). `review-ready` is a step result
   for the task's owner, so the source coordinator gets no line. It sees the event with
   `note list`, because the sender workspace may list and show its notes.
7. No terminal or tab control is granted. Nothing the worker wrote is typed into any tab.

Inputs from the coordinator brief (external designs reviewed), and how they are used:

- openharness: a coordinator that received every server copy got 486 messages a day, and the
  copies were removed. So the coordinator gets a status notice only for a status change
  (`landed`, `blocked-on`), not a copy of every event. A step result (`review-ready`) goes to
  the task's owner.
- A verdict counts only for the exact head and base it read: `head`, `base` and `branch` are
  mandatory in every payload, and a head that is not the branch tip is refused (`range`).
- openharness attempt fencing (`STALE_ATTEMPT`): the scope carries `attempt`; an event from
  another attempt, or a duplicate, is `event-stale`.
- trueforge `NoResponderError`: an event with no live recipient is refused at once.

## 2. The state machine

```
            send (HTTP POST /api/cli/worker-events)
                         |
                       [sent]  ---- caller not a verified tab, a remote tab, no scope, target
                         |          not in scope, attempt != scope attempt, schema invalid -> [refused]
                    validators
                         |  no server patch-id command (event-check-unavailable) ----> [refused]
                         |  any validator fails ------------------------------------> [refused]
                    [validated]
                         |  inside the notes lock: scope re-read; attempt, epic or
                         |  target changed during the checks ------------------------> [refused]
                         |  duplicate dedupe key, earlier note not expired ----------> [refused]
                         |  no live recipient (epic unowned, coordinator not live) -> [refused]
                         |  status note fails: the delivery line is withdrawn ------> [refused]
                         v
                    [delivered]  (note `delivered`; its inbox line is queued, then typed)
                         |
                  note ack by the routed recipient (ADR-0013 rules)
                         v
                      [acked]
```

- `sent`, `validated` and `refused` are states of one request. A refusal answers the HTTP request
  with a code and a reason and writes one `typed-event-refused` line to the coordination audit
  log. Nothing is stored in the notes file.
- `delivered` and `acked` are the states of the delivery note. The note carries the event record
  (`note.event`: type, payload, scope, check ids, dedupe key). A delivered note that later loses
  its recipient re-routes by the notes rules (`queued`, `undeliverable`, `expired`).
- An event is refused at send when it has no live recipient (input 4 of the coordinator brief,
  trueforge `NoResponderError`). The worker learns at once. An event never sits unseen.

## 3. Alternatives, with evidence from the code

| Option | Evidence | Verdict |
|---|---|---|
| A. Extend notes: a new admission mode plus an `event` field on the note | `NotesService.recipientOf` already routes `coordinator` and `owner` admissions across workspaces; `preflight`, `ack`, reminders, expiry and the inbox line (883 lines, ADR-0013) are reused unchanged. `INote` already carries optional producer fields (`externalKey`). | **Chosen.** |
| B. A separate event store with its own delivery | Delivery needs the same pieces as notes: routing at delivery time, re-route on a closed tab, the paste preflight inside the inbox dispatch lock, the ack rules, the 30/60 min clocks. ADR-0013 lists four review rounds of defects in exactly that code. A copy would repeat those defects. | Rejected. |
| C. The work-item ledger (ADR-0033) | `ledger.sqlite` is an append-only metrics feed. It is scoped per workspace by a ledger token (`ledger-token.ts`) and has no delivery path and no recipient. ADR-0026 rules that the harness never acts on a producer's files. | Rejected: a measure, not a message. |

The scope declaration also had alternatives:

- The worker self-declares a `story:<key>` lease with its dependencies in the lease note. Rejected:
  the worker would grant itself its own scope.
- Derive the dependencies from `status.yaml`. Rejected: `_output/` is producer scratch, and the
  harness never reads a producer's files (ADR-0026).
- A coordinator-written scope record (chosen). It costs one coordinator command per dispatch,
  not one turn per hand-off, and the coordinator already runs `tab create` at dispatch.

## 4. The three hardest adversarial inputs

1. **Evidence paths that escape, or that never end.** A payload names `/dev/zero`, a FIFO, a
   symlink to `~/.purplemux/notes.json`, or a 10 GB log. Defence: every path is absolute; the
   reader resolves `realpath` and refuses a path outside the sender workspace's `directories`
   (plus `PMUX_EVENT_EVIDENCE_ROOTS`); it reads only regular files under a byte cap (gate log
   32 MiB, others 1 MiB). The `repo` obeys the same roots. A refusal names the path, never the
   contents.
2. **A key or command that is not what it seems.** The first build ran `tools/patch-id.sh` from
   the payload's repo, so a worker could supply the script that judged its own key (review R1-3).
   Now the command is the server's `PMUX_EVENT_PATCH_ID_CMD`, whose first item must be an
   absolute path that does not resolve inside the payload's repo; unset, the event is
   `event-check-unavailable`. It runs with `execFile` (no shell), `cwd` = the confined repo, a
   minimal environment (`PATH`, `HOME`, `LANG`; no `PMUX_TOKEN`), a 60 s timeout and a 1 MiB
   output cap. Every command run in the sender's repo gets `GIT_CONFIG_COUNT` overrides for the
   git keys that run a program (`core.fsmonitor`, `core.hooksPath`, `diff.external` and seven
   more), which outrank the repo's `.git/config` (review r2 N1). Attribute drivers cannot be
   pinned by name, so the patch-id script must use plumbing with `--no-ext-diff --no-textconv`. `head`, `base` and `key` must match
   `^[0-9a-f]{40}$|^[0-9a-f]{64}$` before they reach an argument list, so `--upload-pack=…` or
   `HEAD~1` never reaches git. `branch` must match a ref grammar with no `..`, no leading `-`.
3. **A stale or replayed result.** (a) A gate log with two runs, the first one green for the head
   tree: only the last run counts (from the last `START=`, the last `GIT_TREE_END=`, `VERDICT=`
   and `SETTLED=`, as `gate-commit-check.sh` reads it), and it must say `VERDICT=VALID` and
   `SETTLED=yes`; a RED run whose tree matches is refused (review R1-1). (b) A head that is no longer the branch tip: `range` refuses
   it (`refs/heads/<branch>` must resolve to `head`, and `base` must be an ancestor of `head`).
   A `landed` head whose branch origin deleted at merge, or that moved on, may instead be an
   ancestor of its `target` (default `main`, local or origin's copy); `review-ready` keeps the
   exact-tip rule (review r2 N2).
   (c) A restarted worker on an old attempt: the payload `attempt` must equal the scope's
   `attempt`, else `event-stale`. (d) The same event twice: a dedupe key, sha256 over
   (type, target, workspace, story or tab, the whole payload with its attempt), is refused as
   `event-stale`, naming the note and its state; a note that expired unacked does not block a
   resend. The check runs inside the notes lock, so two concurrent sends cannot both pass it.
   (e) A re-dispatch while the checks run (up to 60 s): the scope is read again inside the notes
   lock, and a changed attempt or epic is `event-stale` (review R1-5).
   Reads open the resolved path with `O_NOFOLLOW | O_NONBLOCK` and `fstat` the descriptor, so a
   swap to a symlink or a FIFO after `realpath` is refused, not followed or blocked on (R1-7).

Not defended: a worker that forges its own evidence files. The worker owns those files. The
checks catch mistakes (the three found by hand), not forgery. Remote tabs (ADR-0022) keep their
evidence on another host, so the server cannot read it: a tab whose layout names a host, or
whose host cannot be read, is refused at send with `event-check-unavailable`, and it keeps the
coordinator path.

## 5. Acceptance criteria

- AC1: `event send` from a verified worker tab with a declared scope, to its served epic or to a
  declared dependency, with valid evidence, creates one note with `admission.mode = "event"`,
  routed to the target's recipient by the ADR-0013 rules. No coordinator re-types it.
- AC2: each payload schema is strict: a missing field, a wrong form, or an unknown field is
  `event-invalid` (exit 2), and the message names every defect.
- AC3: each validator refuses with `measured` beside `expected`. Every type runs `range` (head
  is the branch tip; base is its ancestor). `review-ready` and `landed` run `gate-verdict` (the
  last run says `VERDICT=VALID` and `SETTLED=yes`), `gate-tree` (last-run `GIT_TREE_END=`
  equals `git rev-parse <head>^{tree}`) and `patch-id` (the server's command over `base..head`
  prints `key`). `review-ready` also runs `review-folder` (the folder holds `range.txt`,
  `diff.patch`, `status.txt`, `patch-id.txt`, `record.md`) and, when a receipt is given,
  `receipt` (it exists, is named `<key>.md`, and holds no `verdict: BLOCK`, which belongs at
  `<key>.block.md`). A first hand-off with no receipt is delivered.
- AC4: a validator failure is `event-refused` (exit 3) and lists every failed check.
- AC5: a target outside the scope, a tab with no scope, an unverified caller, or an admin token is
  refused (`event-out-of-scope` or `forbidden`, exit 3). Only the workspace's verified designated
  coordinator sets or clears a scope.
- AC6: the receiving recipient gets the notes' fixed inbox line and acks with `note ack`.
  `landed` and `blocked-on` also send one status note to the source coordinator, except when the
  coordinator is the delivery recipient. `review-ready` sends the coordinator no line.
- AC7: an old attempt, a scope changed during the checks, or a duplicate whose note has not
  expired is `event-stale` (exit 3); an event with no live recipient is `event-no-recipient`
  (exit 5) and stores nothing; a failed status note withdraws the delivery's line and stores
  nothing.
- AC7b: a remote tab, a tab whose host is unknown, and a server with no usable
  `PMUX_EVENT_PATCH_ID_CMD` are `event-check-unavailable` (exit 3); the refusal names the host or
  the variable, and nothing under the payload's repo runs.
- AC8: every validator has a hermetic test over a fake reader, and every state above has a test.
  Each test is proven by the mutation recorded below.
- AC9: `pnpm lint && pnpm test && pnpm build` pass.

## Mutation record

Each row: the change made to the code, and the first test that failed. Each change was applied
alone, its test file was run, and the change was reverted (`mutate.py`, kept outside the
repository). The whole set was run again after review round 1, on the round-1 tree. Result:
64 of 64 mutations killed. In the first run after round 1, `R1-1b` (a missing verdict
accepted) survived: its test gave no `SETTLED=yes` line, so the run failed on `SETTLED` alone.
A case with `SETTLED=yes` and no `VERDICT=` was added, and `R1-1b` is now killed. Review round 2 added eight
mutations for its nits (`R2-*`), run on the round-2 tree: all eight killed, so 72 of 72.

| # | Mutation | Failing test |
|---|---|---|
| M1 | schema: unknown fields accepted | `worker-event-schema.test.ts`: names every defect: a missing field, a wrong form and an unknown field |
| M2 | schema: abbreviated object ids accepted | `worker-event-schema.test.ts`: refuses an abbreviated head |
| M3 | schema: text not cleaned of control characters | `worker-event-schema.test.ts`: accepts each type with exactly its fields and normalises paths |
| M4 | evidence-paths: confinement off | `worker-event-validators.test.ts`: refuses a path that resolves outside the roots, and reads nothing at it |
| M5 | evidence-paths: root prefix without separator | `worker-event-validators.test.ts`: refuses a root prefix that is not a parent (/w2 is not under /w) |
| M6 | evidence-paths: entry kind unchecked | `worker-event-validators.test.ts`: refuses a missing path, a FIFO-like entry and a file where a directory belongs |
| M7 | range: branch tip unchecked | `worker-event-validators.test.ts`: refuses a stale head (the branch moved on) |
| M8 | range: ancestry unchecked | `worker-event-validators.test.ts`: refuses an absent branch, a base that is no commit, and a base off the branch |
| M9 | gate log: whole log read, not the last run | `worker-event-validators.test.ts`: refuses a log whose last run has no GIT_TREE_END, although an earlier run had the right one |
| M10 | gate-tree: tree not compared | `worker-event-validators.test.ts`: refuses another tree, naming both |
| M11 | patch-id: exit code ignored | `worker-event-validators.test.ts`: refuses a failed command with its first words of stderr, control characters removed |
| M12 | patch-id: printed key not compared | `worker-event-validators.test.ts`: refuses another key, naming the command and what it printed |
| M13 | review-folder: record.md not required | `worker-event-validators.test.ts`: names every missing file |
| M14 | review-folder: patch-id.txt key not compared | `worker-event-validators.test.ts`: refuses a folder that reviews another key |
| M15 | receipt: name unchecked | `worker-event-validators.test.ts`: refuses a receipt under another name |
| M16 | receipt: BLOCK only on the first line, case-sensitive | `worker-event-validators.test.ts`: refuses <key>.md holding "# r\n  Verdict:   block — gate missing\n" |
| M17 | runner: a throwing validator passes | `worker-event-validators.test.ts`: counts a validator that throws as a failure of that check, never a pass |
| M18 | runner: stop after the first failure | `worker-event-validators.test.ts`: refuses a head with no tree and an over-size log |
| M19 | reader: caller environment passed to the command | `worker-event-validators.test.ts`: runs the command without a shell or the server token, in the repo |
| M20 | scope: any verified tab declares | `worker-events-service.test.ts`: is the verified designated live coordinator only |
| M21 | scope: epic of another workspace accepted | `worker-events-service.test.ts`: serves only an epic held by a live tab of the same workspace, for a live tab of that workspace |
| M22 | scope: attempt may go down | `worker-events-service.test.ts`: keeps the attempt on a re-declare, raises it on a re-dispatch, and never lowers it |
| M23 | scope: unknown-state tabs pruned | `worker-events-service.test.ts`: drops the scopes of closed tabs, but not of tabs whose state is unknown |
| M24 | send: target outside the scope accepted | `worker-events-service.test.ts`: refuses a target outside the scope, a tab with no scope, and a scope whose epic was released |
| M25 | send: old attempt accepted | `worker-events-service.test.ts`: refuses an old attempt as stale (attempt fencing) |
| M26 | send: released served epic accepted | `worker-events-service.test.ts`: refuses a target outside the scope, a tab with no scope, and a scope whose epic was released |
| M27 | send: unverified tab accepted | `worker-events-service.test.ts`: refuses an admin token, a workspace token and an unverified tab: no blanket authority |
| M28 | status: review-ready copied to the coordinator | `worker-events-service.test.ts`: sent → validated → delivered: a worker reaches another workspace's coordinator without its own retyping it |
| M29 | notes: duplicate delivered twice | `worker-events-service.test.ts`: refuses the same event twice as stale, naming the note that carried it |
| M30 | notes: no-recipient event stored | `worker-events-service.test.ts`: refuses an event with no live recipient and stores nothing (no event sits unseen) |
| M31 | notes: event admission not routed across workspaces | `worker-events-service.test.ts`: sent → validated → delivered: a worker reaches another workspace's coordinator without its own retyping it |
| M32 | notes: status note to a coordinator that is the recipient | `worker-events-service.test.ts`: sends no status note when the source coordinator is the recipient, or is the sender |
| M33 | notes: unverified sendEvent accepted | `worker-events-service.test.ts`: refuses an admin token, a workspace token and an unverified tab: no blanket authority |
| M34 | notes: status note not counted in the cap | `worker-events-service.test.ts`: counts the delivery and its status note against the sender cap |
| M35 | http: event-refused answered 400 | `worker-events-route.test.ts`: answers event-refused with 422 |
| M36 | http: details dropped | `worker-events-route.test.ts`: answers event-invalid with 400 |
| M37 | cli: event-no-recipient exits 3 | `cli-event.test.ts`: maps event-no-recipient (HTTP 503) to exit 5 |
| M38 | cli: dependsOn not split | `cli-event.test.ts`: sets a scope with split dependencies and a numeric attempt |
| M39 | validators: path.join(dir, name) back in the review-folder check | `worker-events-trace-boundary.test.ts`: src/lib/worker-event-validators.ts builds no path with path.join or path.resolve |
| R1-1a | gate-verdict: any verdict accepted | `worker-event-validators.test.ts`: refuses a RED run whose tree is the head's tree |
| R1-1b | gate-verdict: a missing verdict accepted | `worker-event-validators.test.ts`: refuses a run with no verdict, and a run with no SETTLED=yes |
| R1-1c | gate-verdict: verdict read across runs (a RED run after a VALID run passes) | `worker-event-validators.test.ts`: refuses a log whose last run has no GIT_TREE_END, although an earlier run had the right one |
| R1-1d | gate-verdict: first VERDICT= of the run, not the last | `worker-event-validators.test.ts`: reads the last run as gate-commit-check.sh does |
| R1-1e | gate-verdict: SETTLED=yes not required | `worker-event-validators.test.ts`: refuses a run with no verdict, and a run with no SETTLED=yes |
| R1-1f | gate-verdict: AFFECTED-VALID accepted | `worker-event-validators.test.ts`: refuses a subset run (AFFECTED-VALID) and a look-alike, and takes VALID with a note |
| R1-1g | gate-verdict: not run for landed | `worker-event-validators.test.ts`: passes every check of review-ready, landed and blocked-on |
| R1-2a | schema: receipt required on review-ready again | `worker-event-schema.test.ts`: takes review-ready without a receipt: the first hand-off for review has none yet (ruling R1-2) |
| R1-2b | schema: gate log not required on landed | `worker-event-schema.test.ts`: accepts each type with exactly its fields and normalises paths |
| R1-2c | receipt: checked when absent | `worker-events-service.test.ts`: delivers a first hand-off for review that names no receipt (R1-2) |
| R1-2d | evidence-paths: a given receipt not resolved | `worker-event-validators.test.ts`: passes every check of review-ready, landed and blocked-on |
| R1-3a | patch-id: unset variable falls back to the repo script | `worker-event-validators.test.ts`: has no command for PMUX_EVENT_PATCH_ID_CMD=undefined (ruling R1-3) |
| R1-3b | patch-id: a relative program accepted | `worker-event-validators.test.ts`: has no command for PMUX_EVENT_PATCH_ID_CMD="[\"tools/patch-id.sh\", \"{base}\", \"{head}\"]" (ruling R1-3) |
| R1-3c | patch-id: a program inside the sender repo executed | `worker-event-validators.test.ts`: never executes a program under the sender's repo, even when the server names one |
| R1-3d | service: an unavailable check reported as event-refused | `worker-events-service.test.ts`: refuses as event-check-unavailable, naming the variable, when no patch-id command is configured (R1-3) |
| R1-3e | cli: event-check-unavailable exits 1 | `cli-event.test.ts`: maps event-check-unavailable (HTTP 409) to exit 3 |
| R1-4a | send: a remote tab accepted | `worker-events-service.test.ts`: refuses a remote tab, and a tab whose host is unknown, before reading any evidence (R1-4) |
| R1-4b | send: a tab of unknown host accepted | `worker-events-service.test.ts`: refuses a remote tab, and a tab whose host is unknown, before reading any evidence (R1-4) |
| R1-5a | notes: scope not re-read inside the lock | `worker-events-service.test.ts`: refuses a result whose scope was re-dispatched, cleared or narrowed while the evidence was checked (R1-5) |
| R1-5b | recheck: attempt not compared | `worker-events-service.test.ts`: refuses a result whose scope was re-dispatched, cleared or narrowed while the evidence was checked (R1-5) |
| R1-5c | recheck: narrowed scope not compared | `worker-events-service.test.ts`: refuses a result whose scope was re-dispatched, cleared or narrowed while the evidence was checked (R1-5) |
| R1-6a | notes: an expired note still blocks a resend | `worker-events-service.test.ts`: lets an event be sent again once its note expired unacked, and says when it is still open or acked (R1-6) |
| R1-6b | notes: the delivery line left behind when the status note fails | `worker-events-service.test.ts`: withdraws the delivery's queued line when the status note fails, and stores nothing (R1-6) |
| R1-7a | reader: symlinks followed on open | `worker-event-validators.test.ts`: opens with O_NOFOLLOW and O_NONBLOCK: a symlink fails, and a FIFO is refused without blocking (ruling R1-7) |
| R1-7b | reader: open blocks on a FIFO | `worker-event-validators.test.ts`: opens with O_NOFOLLOW and O_NONBLOCK: a symlink fails, and a FIFO is refused without blocking (ruling R1-7) |
| R2-N1a | reader: no git config overrides in the command environment | `worker-event-validators.test.ts`: pins the git keys that run a program, above the repo's own config, for every command it runs (review r2 N1) |
| R2-N1b | reader: diff.external not pinned | `worker-event-validators.test.ts`: pins the git keys that run a program, above the repo's own config, for every command it runs (review r2 N1) |
| R2-N2a | range: landed never looks in its target branch | `worker-event-validators.test.ts`: passes a deleted branch whose head is in main |
| R2-N2b | range: landed accepts a head in no branch | `worker-event-validators.test.ts`: checks the named integration branch in place of main |
| R2-N2c | range: origin's copy of the target not read | `worker-event-validators.test.ts`: passes a branch that moved on, and a head that only origin's main holds |
| R2-N2d | range: base ancestry skipped for a head found in the target | `worker-event-validators.test.ts`: still checks that base is an ancestor of a head found in main |
| R2-N2e | range: review-ready also accepts a head in main | `worker-event-validators.test.ts`: keeps the exact-tip rule for review-ready |
| R2-N2f | schema: target accepted on review-ready | `worker-event-schema.test.ts`: accepts each type with exactly its fields and normalises paths |
