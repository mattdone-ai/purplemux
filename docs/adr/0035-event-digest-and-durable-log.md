# ADR-0035: Event digest and a durable tab event log

## Status
Accepted (2026-11-03, epic `harness-flow-loop`, story 09; architecture ADR-HFL-05 decisions 1-3). Amends ADR-0033 §1
(two columns and four partial indexes on `tab_events`) and §9 (`tab_events` kept 30 days), and ADR-HFL-05 decision 1
twice: the duplicate rule does not apply to urgent events (consult ruling 2026-11-03), and a copy is a duplicate only
while the earlier one is still undelivered (review round 2, F3).

## Context
The v2 orchestrator took 18,026 inputs in 14 days (audit), 68% of them trivial (1-2 API calls, at most 1 tool call).
Measured again for this story with the same method (`evidence/09/wake-measure.py`, transcripts `01829b72` and
`621a342e`, 2026-10-31T06:00Z to 11-03T06:00Z): 3,894 inputs, 1,298 a day, 71.1% trivial. By source: another seat's
`tab send` 1,723 (1,199 trivial; most carry the fleet header `FROM -> TO (cc COPIES): ...`, in which the `->`
recipient gets the original and only the cc tabs get copies), watchdog CHECKPOINTED 1,440 (1,266 trivial),
subagent completions 331, pastes 150, Mission Control 89, other watchdog nudges 69, SM heartbeats 54, DONE 18, BLOCKED
12, notes 8. Every watchdog nudge was typed at once, mid-turn too (`deliverAutomatedPrompt`), and the nudge history was
200 entries in memory (`MAX_NUDGE_HISTORY`, `status-manager.ts:1157`), lost on every restart.

## Options considered
1. **`--report-on` alone** (ADR-0025): drops CHECKPOINTED from the orchestrator's wakes but loses it; nothing records
   it and nothing reaches the seat later.
2. **Batch in the inbox** (ADR-0012): the inbox already types only into a ready, empty composer, but its lines carry
   no caller text by design, and a digest carries the worker's end lines.
3. **A class per event, a durable log, and a digest the router types only at the prompt.**

## Decision
Option 3.

1. **One class table** (`src/lib/wake-class.ts`, `WAKE_CLASS_TABLE`, `classifyWake(kind, detail)`). `urgent`: a
   `turn-marker` whose last line is DONE, BLOCKED, NEEDS-DECISION, READY-TO-MERGE or any line but CHECKPOINTED;
   `needs-input`, `off-scope`, `thrash`, `api-error`, `usage-limit`, `inactive`, `stalled`, `model-drift`; `bg-*` to
   the tab that registered the job; inbox `mission`, `resume`, `watch`, `deploy`; `red-main`, `rotate`; a block-severity
   `flag` or `alarm`; a `tab-send` that is not a copy. `digest`: CHECKPOINTED; `turn-ended`, `ready-for-review`,
   `idle-no-end-line`, `long-wait`, `stuck`, `probe-failed`; `bg-*` to another tab; the first `heartbeat` of an idle
   episode; `note`; a warn `flag` or `alarm`; a `tab-send` to a tab that is a copy (its name on the header's `cc`
   list and not among the `->` recipients; a header name matches the tab's name, a part of it, a prefix of a part of
   at least 3 letters, or its initials: `ORCH` is `v2-orchestrator`, `SM` is `v2-scrum-master`), or one that says "no
   reply needed". Such a send stays urgent when a line, or the text right after the header, starts with DONE:,
   BLOCKED:, NEEDS-DECISION: or READY-TO-MERGE:, or when it relays an owner's answer verbatim (ADR-HFL-05 names an
   owner answer urgent; the scrum master's approval route is this relay). Architect ruling 09-C1: the first cut held
   every send with a cc list, which held the original for its `->` addressee. `log`: later heartbeats of the same idle episode. A kind outside the table is urgent: a class
   never holds what it cannot name.
2. **Duplicates.** A digest or log event whose tab, kind and text match an event of the last 15 min that is still
   undelivered is logged, not delivered (a logged copy does not extend the window). A delivered copy never suppresses
   a later one: the watchdog's templates carry no episode token (`turn-ended`, `stuck`, `idle-no-end-line` read the
   same for every stop of one worker), so a matching text after delivery is a new event (review round 2, F3). Urgent
   events keep only the 60 s episode filter (`nudge-dedupe.ts`): the same `DONE:` after a fix round is a new decision,
   and urgent volume (about 10 a day) makes the rule worth nothing there.
3. **Digest delivery** (`src/lib/tab-event-router.ts`). One message, `DIGEST <n> since <time>`, a line per event
   (watchdog prefix and pane pointer dropped, 160 characters) while the whole stays within 2,048 bytes, then
   `Full text:` or `<k> more:` and `purplemux events show -w WS TAB --since <time>`. It is typed when the tab is at its
   prompt (`StatusManager.isAtPrompt`: idle, ready-for-review, or busy only because its stop waits on its own
   background work; not halted by a usage limit, not being closed), re-checked inside the dispatch lock just before the
   paste (`IAutomatedPromptRequest.whenReady`), and 15 min have passed since the tab's last digest or 20 events wait.
   No digest goes within 5 s of any delivery to the tab (an urgent paste, a notice, a send): the turn that paste
   started may not show in the tab's state yet (review round 2, F10). The window is read again inside the tab's
   dispatch lock, after any paste queued ahead of the digest. A 5 s tick and every new digest event check it.
   When a digest goes out, the nudges it carried are broadcast again under their ids, delivered, so a client that
   showed them as held updates them. A tab whose oldest held event is an hour old (it was never at its prompt: dead or
   always busy) is reported to the human once per backlog through the flag alert path (ADR-0032), with the
   `events show --since` command that shows it. A closed tab's held events become `log` rows when it closes, and a tab
   that closed while the server was down is retired the same way on the first stale tick, never reported.
4. **The durable log.** `tab_events` in `ledger.sqlite` (ADR-0033's table, the ledger's own handle) records every
   event first, then its delivery: `delivered_at`, and `digest_id` for the digest that carried it. It replaces the
   in-memory `orchestrationNudges`: `getOrchestrationNudges` reads the newest 200 rows that carry a source tab. Two
   nullable columns, `source_tab_id` and `source_tab_name` (the worker a nudge is about), and two partial indexes (the
   pending digest events; the delivered rows) are added in place: `user_version` stays 1, so a server rolled back to a
   build without them opens the file as before and names neither (the ADR-0023 rollback lesson). After a rollback the
   held non-urgent events stay in `tab_events` and the old release does not read them: read them with `purplemux
   events show` after rolling forward. Indexes, all
   partial: the held events per tab; the delivered rows per workspace; the digests per tab, by delivery (the
   last-digest read on every tick); the nudges per workspace, by seq (the history). An event the router holds is kept
   whole: it is the only copy until its digest; one another path typed (an urgent `tab send` brief) is kept to 16,384
   characters. Retention 30 days. Inbox notices keep their own delivery and receipts and are recorded when typed; an
   urgent `tab send` is recorded when typed; a digest-class `tab send` to a tab with no live session answers 409
   `session-not-running`, as any send does. **Delivery never depends on a ledger write:** a ledger that cannot be
   opened, or a write that fails (the duplicate check, the append), types every non-log event at once and logs one
   line naming the error; a delivery that cannot be recorded after its paste is logged and never typed again.
5. **Reads.** `GET /api/cli/workspaces/{ws}/events?tab=&since=&limit=` (`purplemux events show -w WS [TAB] --since 1h`;
   for one tab it prints every event whole, the text the digest's pointer names; for the workspace, one line each)
   and `GET .../events/wakes?since=&until=&by=window|day` (`purplemux events wakes`). `since` takes an age (`15m`,
   `1h`, `7d`), Unix ms or ISO-8601.
6. **Metrics for the finder.** `getLedgerStore().tabEvents.wakes(workspaceId, { since, until, byDay? })` returns
   `ITabWakeRow[]` = `{ tabId, day: 'YYYY-MM-DD' | null, wakes, digests, urgent, logged }` per tab (and per UTC day of
   the delivery with `byDay`). A wake is one delivery: an event delivered on its own (`urgent`) or a digest counted once
   however many events it carried; undelivered and `log` rows never wake; `logged` counts `log` rows recorded in the
   window. `tabEvents.hasAny(workspaceId)` tells "no record" from "a quiet seat". Wakes per hour per seat over 6 h is
   `wakes / 6` of `wakes(ws, { since: now - 6 h, until: now })`.

## Measured (review round 2)
150,000 rows over 30 days (5 workspaces, 30 tabs; a quarter sourced nudges of about 250 characters, the rest sends of
about 600), local disk (`evidence/09/f5-index-measure.json`): 710 bytes a row; at the baseline 1,298 inputs a day that is
about 0.9 MB a day and 28 MB at 30 days. Medians (p99), 200 runs: last digest of a tab 0.010 ms (0.026), the 200-nudge
history 0.385 ms (0.957), last delivery inside 5 s 0.010 ms (0.028), held tabs 0.012 ms (0.018), duplicate check
0.015 ms (1.243), wakes over 6 h 0.306 ms (1.779).

## Consequences
A seat is woken for what it must act on; the rest arrives at most four times an hour, at its prompt. A restarted or
rotated tab reads what it was sent. The class table is the one place a kind's urgency is decided; a wrong class is
fixed there, never in the digest. `--report-on` stays: a worker that reports only DONE and BLOCKED sends no
CHECKPOINTED at all.

## What proves it wrong
Run `evidence/09/wake-measure.py` over the 3 days after the deploy. Inputs stay at 400 a day or more, trivial wakes
above 20% (ADR-HFL-05: above 40% is the failure line), an urgent kind above 50% trivial, a seat acting on a tab in its
first turn after a digest that carried that tab's event, or a worker idle more than 2 min behind a held event. Then
the class table is wrong for that kind. Urgent same-text deliveries from different episodes above 5% of urgent
deliveries and rated trivial would make the duplicate rule worth extending to urgent events.

## Amendment (2026-11-03, regression fix after release acceptance)
The nudge history (`getOrchestrationNudges`, the watchdog view and `orchestration status`) leaves out an urgent row while
its paste is still running, so a nudge enters the history with its final outcome; the history can therefore return fewer
than 200 rows. The page decision never read the history: it uses the paste result. A server restart in the middle of a
paste leaves that row `delivered: false` in the table and the history, although the paste may have landed: read it as
"outcome unknown after a restart". `purplemux events show` reads the table directly and can show an urgent row as not
delivered while its paste runs.


## Amendment (2026-11-03, story 13: alarm routing)

Ledger flags enter the router from the flag tick (ADR-0032, amendment of 2026-11-03): an item alarm as kind `alarm`
and an anomaly's line as kind `flag`, each classed by §1's severity rule (block urgent, warn digest). §2's duplicate
rule is unchanged and never suppresses an alarm repeat, whose text carries the age; the hourly repeat of a standing
alarm is the tick's, and the raise and every repeat are held back while a copy of the same item and reason still waits
for the tab's digest.
`TabEventsTable.copies(workspaceId, tabId, kind, opening, since)` answers that guard from the log (one held copy, and
the latest delivery of any copy, matched on the text's opening), over `tab_events_tab_idx`.

## Amendment (2026-11-03, story 15: effect counts)

§7. **What followed each delivery** (architecture ADR-HFL-03, the improvement seat's input; consult ruling and review
round 2 in the story file). Additive, as §4: `user_version` stays 1.
- `tab_events.rule`: the rule of a `flag` (the finder anomaly id) or the reason of an `alarm`, written by the flag tick's
  router call. An alarm's derived reason (`land-queue/lock-busy`, `land-queue/head-blocked`) is counted under its
  parent (`alarm:land-queue`), one row per reason, as the thresholds and routes are. A `flag` or `alarm` row without a
  rule is its own component, not measured, never folded into a rule.
- `tab_turns(id, workspace_id, tab_id, provider, started_at, ended_at, tool_calls)`, index `(workspace_id, ended_at)`,
  kept 30 days as `tab_events`; `ledger_meta` `turns-measured-since` is stamped by the first row. The status manager
  writes one row per stop or interrupt (`src/lib/turn-tracker.ts`). A turn starts at a user prompt (Claude and Grok
  prompt-submit, Codex UserPromptSubmit), or at the first tool call after a stop the server saw (Claude and Grok: work a
  background job resumed); a prompt inside an open turn continues it. Codex PreToolUse and PostToolUse, which the
  work-state machine reads as prompt-submit, start no turn: with none open they open one of unknown start. A session
  start ends any open turn with no count (an agent relaunched after dying mid-turn). `tool_calls` counts acting calls
  only (edit, write, shell): Claude's PostToolUse matcher already sends no other, and Grok's and Codex's tool names
  are filtered to the same class (`isActingTool`). A Claude tool hook is posted detached, so one within 3 s after its
  turn's stop is added to that turn. A turn whose start the server did not see has `started_at` and `tool_calls` NULL.
  Only a counter moves on a tool call; a write failure is logged once and never reaches the hook.
- `GET /api/cli/workspaces/{ws}/effects?days=N` (`purplemux effects show [-w WS] [--days N] [--json]`, read scope,
  N 1..30, default 7).
  - `fired`: the rows the router recorded in the window, any class. A firing dropped before the router (the 60 s
    episode filter), routed to the board only, or sent to the phone only is not recorded.
  - `delivered`: delivery units, one per paste: an urgent event, or a digest counted once per component it carried
    (`inDigest`), every event of a digest taking the digest's outcome. Delivered 0 means the component reached no tab,
    not that it never fired: board-only routes, debounced and duplicate firings read 0 too.
  - `followed`: the recipient's next turn made at least one acting call. It is temporal, not causal: it says what
    came next, not what the delivery caused. The next turn is the one running at the paste or the first after it,
    and it must start within 30 s of the paste (`nextTurnBoundMs`). Measured live by the story 15 reviewer, paste to
    turn start for 67 deliveries to idle tabs, 2026-11-02..03: 51% within 5 s, 58% within 30 s, median 4.7 s, p90
    1,118 s; the 42% past the bound read `noTurn`. A turn hundreds of seconds later is another input's, and an
    hours-later human prompt never counts. A turn that started more than 5 s before the paste is `midTurn`; no turn by
    the bound, at a tab with turns recorded in the window, is `noTurn` (judged, not followed); a turn still running in
    this server, or a paste younger than the bound, is `pending`; a tab gone with no turn is `closed`; a NULL start or
    count, or a tab with no turn recorded in the window, is `unmeasured`. `judged` is delivered less midTurn, pending,
    closed and unmeasured.
  - `candidate`: a deletion candidate rests on observed turns, never on absence: at least 10 deliveries whose turn was
    recorded (judged less noTurn) and none followed; `candidateReason` says why. Fewer observed, noTurn only, or
    delivered 0 whatever fired, is null, "not measured": a component whose firings do not all reach tabs is never a
    candidate on delivered 0 alone.
  - The window is clamped to `turns-measured-since`; before it, every row reads "not measured" with null counts.
- **Components** come from the code, not from the rows, so one that reached no tab shows a true 0: every
  `TOrchestrationNudgeKind` (family `nudge`, with `stalled` and `probe-failed` as `probe`; per-probe effect is not
  measured, counts are per firing kind), every inbox kind, `tab-send` and `rotate` (`notice`), `flag:<anomaly>` for
  every finder anomaly and `alarm:<reason>` for every wait reason (`flag`). The `red-main` kind is not listed: nothing
  routes an event of that kind, and a red main reaches a tab as `alarm:red-main`. The fleet flags (ADR-0023) and flow
  flags (ADR-0032) reach only the phone: `fleet:<flag>` and `flow:<rule>` are listed as not measured. A kind no
  catalog names is `other`.
- **One WIP cap.** The harness enforces one cap on work in progress: the per-workspace agent-tab cap (ADR-0027,
  `tabs.cap-per-workspace[.<ws>]`). The library's `/run-tabs [max-workers]` is a dispatch limit the orchestrator
  applies under that enforced cap (worker-slots.sh counts against it), not a second cap.

What proves it wrong: a component whose followed share moves with no change to it, or a seat that acts on a paste in a
turn the count calls mid-turn or no-turn more often than not. Then the turn boundary or the bound is wrong for that
provider; fix the tracker or the bound, not the rows.
