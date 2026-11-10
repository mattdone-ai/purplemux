# ADR-0044: Typed turn ends: the stop payload and `purplemux done`

## Status
Accepted (2026-11-10, epic `delivery-flow-fix`, story F6, which folds in F10 steps 1 and 2). One Opus 5.5 xhigh
design consult, APPROVE-WITH-CHANGES. Amends ADR-0018 (the turn end is a row when one exists) and ADR-0043 (a scope
carries a seat). Amended the same day by an architect /party (Opus 5.5 xhigh, ruling SIMPLIFY, after three CONFIRM
rounds on the held stop): no stop is held. That party is the authority that amends the consult's ruling (6) (a
contradicted row was a hold reason in a budget of two; now the precedence order of item 5 decides it at the first
stop) and withdraws the hold parts of its rulings (3) and (4) (the pending hold, its `idle_prompt` and undelivered
paths, and the never-held list as a list of holds).

## Context
A worker's verdict was a regex over the last 600 characters of its transcript: one end line was refused 406 times in
36.5 h, and a slow transcript flush read as no end line. The Stop hook dropped its own payload, which carries the
message. F10 (typed control channel) plans a typed turn end in two steps before any delivery change; this record
takes those two steps.

## Decision
1. **The stop payload (F10 step 1).** The Claude Stop hook posts its own JSON to `/api/status/hook?kind=stop&session=`.
   The stop's `last_assistant_message` (its last 600 characters) is the tail when its `session_id` is the tab's bound
   session. The transcript is still read for the background counts, and a different end line there is logged. Fleet
   key `hook.stop-payload=off` restores the transcript tail.
2. **The row (F10 step 2).** `purplemux done --verdict DONE|BLOCKED|NEEDS-DECISION|READY-TO-MERGE|CHECKPOINTED
   [--reason] [--story] [--head] [--gate-log]` writes one `turn_ends` row (`ledger.sqlite`, additive). Its key is
   (agent session, turn id). The turn id is a per-session counter in `session_turns`, bumped by each live
   prompt-submit that no tool sent. It is never the in-memory event sequence, which a restore resets. A second `done`
   in the turn replaces the first; exactly one stop consumes a row.
3. **Checks at write time.** These are the ADR-0043 validators `range`, `gate-verdict` and `gate-tree`, and only
   these. The repo is the git top level of the caller's cwd, and `head` defaults to its branch tip. A builder seat's
   DONE and READY-TO-MERGE need `--gate-log`. A reviewer or consult seat may give one, and it is checked when given.
   `--reason` is cleaned to one line of at most 500 characters; a reason with a marker word is refused. BLOCKED and
   NEEDS-DECISION need a reason. A remote tab cannot write a row: the server cannot read its evidence.
4. **The seat.** `event scope set … --seat builder|reviewer|consult`. With no seat declared, a scope that names a
   story is a builder.
5. **At the stop: no stop is held.** The route decides within 1 s (past that, the classifier), applies the stop and
   answers `{}`; the script prints nothing, whatever the answer. The decision only finds the row of the stop's own
   turn, or marks the turn end:
   - **WAITING:** a stop whose tail has no marker and no row, while the tab has a live registered job, an armed watch
     or an open provider task, is WAITING and asks no row. An unknown count asks none either.
   - **No row:** a scoped worker's turn end with no row gets an `UNREPORTED` `no-row` row and the classifier's verdict.
     A stop no row is asked of (a StopFailure, a replay, a remote, evaluator or non-Claude tab, a tab in an open
     rotation) gets `no-row:<why>`; a coordinator and an unscoped tab keep the classifier alone. These rows measure
     adoption: `done` is voluntary.
   - **One precedence order, evaluated once, at apply time, against E** (party ruling, section 1). E is the end line
     the stop applies: the stop's own message when it is the bound session's and `hook.stop-payload` is on, else the
     transcript tail. The other tail is shadow data, never a source. The first candidate that exists wins:
     1. a `NEEDS-DECISION` row
     2. a `NEEDS-DECISION:` end line in E
     3. a `BLOCKED` row
     4. a `BLOCKED:` end line in E
     5. a rank-0 row (`DONE`, `READY-TO-MERGE`, `CHECKPOINTED`)
     6. a rank-0 end line in E
     7. WAITING
     8. ready-for-review

     That is: the higher rank wins (NEEDS-DECISION > BLOCKED > the rest), and on equal rank the row wins. Rank comes
     first because a lost escalation costs a stalled story or an unanswered owner question (ADR-0041: a question never
     vanishes); within a rank a row carries checked evidence. A row that wins is applied as its synthesized line
     `<MARKER>: <reason> (story K, head <12>, gate <verdict>)`, which feeds the nudge, `reportOn`, the coordinator
     window and the NEEDS-DECISION item. A row that loses is consumed and kept, and the override is logged with both
     verdicts. The classifier's own verdict is the row's shadow (7 days, then F10 step 5 deletes it).
6. **Turns and replays.**
   - Live or replayed is the dispatch's own flag (`replayed`, set only by the spool drain), never the event time: a
     live hook carries its `occurredAt` in the same time parameter as a replay (CONFIRM review, round 2). A replayed
     prompt-submit opens no turn.
   - A replayed stop is judged against its own turn: the latest turn that started at or before it fired
     (`session_turn_starts`), never the session's current turn. `consume` is single-use, so a replay applies once.
   - An `UNREPORTED` write never replaces a row. When the turn has one, that row is kept and marked used.
   - The Stop and StopFailure hooks both get a 5 s timeout (tmux 1 s, the POST 3 s).
   - **Reopen trigger for holding** (party ruling): only as its own story with design check T1, when the team runner
     or a revived F10 step 3 needs a Stop-hook block. It must model every exit (continue, stop again, `idle_prompt`,
     prompt-submit, restart, session-start, kill-switch flip), keep its pending state durable, and never hold an
     escalating end line.
7. **Kill switches**, admin token only: `turn-end.source` (`row`, or `classifier` to read no rows at all) and
   `hook.stop-payload` (`on` or `off`).

## Consequences
- The guard holds nothing: every stop goes through on its first answer.
- Rows are voluntary. Rows are reported by source (`done`, `unreported` with its reason); the `no-row` count measures
  adoption.
- F10 step 3 (messages) and step 5 (deleting the classifier) build on these rows; neither is part of this record.
