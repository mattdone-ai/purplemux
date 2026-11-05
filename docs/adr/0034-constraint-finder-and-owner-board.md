# ADR-0034: The constraint finder and the single owner board

## Status
Proposed (2026-11-03, epic `harness-flow-loop`, story 03: the finder, the board read and the CLI). The epic's
ADR-HFL-02. Extended by story 12 (2026-11-03): the pulse (§9), the board view, the goal and what Needs you blocks (§10).

## Context
About eight progress surfaces exist, and none says where work is stuck. The owner asked for status and ETAs 36 times
and said a page was out of date 25 times in 14 days (epic research 3.3). The work-item ledger (ADR-0033) now records
every wait with a reason from a closed vocabulary. What is missing is one computed answer: which reason holds the most
waiting time now, whether it is getting worse, who holds it and what clears it, with every measure that rests on a
missing input shown as unknown.

## Options considered
1. **Keep the surfaces; add a ledger panel to Mission Control.** A ninth surface.
2. **A static page rendered by a timer.** No answers, one more renderer to keep true.
3. **One purplemux view, the board, server-derived from a pure finder, inside Mission Control.**

## Decision
Option 3. This record holds the finder and the board read; story 12 adds the view.

1. **Finder.** `deriveConstraint(ledger, flow, spend, pool, now)` in `src/lib/constraint.ts`: no Node import, no I/O,
   no clock (a test reads its imports). Windows 6 h, 24 h and 7 d. Per reason and per stage: WIP, summed waiting hours,
   p50 and p90 of the waits that finished inside the window, throughput (waits finished inside it), and the trend
   against the window before; per window, items closed by type. Stages are the ledger's (`build-review`, `land`,
   `deploy`, `people`, `hosts`, and `unknown`): the epic's "build, review" is ADR-0033's one `build-review` stage.
   Waiting hours are finished waits clipped to the window plus open waits' elapsed time clipped to it, the read-time
   `unknown` of silent wait-life items included.
2. **The constraint** is the reason with the largest waiting hours in the last 24 h on critical items when any critical
   item waited, else on all items (`basis`). An item is critical when it, its parent, or the slice its own key names
   (`range:<lane>:<key12>` -> `slice:<lane>`) carries `attrs.critical` (v2 publishes `.v2/critical-path`): a fold member's
   parent is its fold, and its own lane may be critical (architect consult 03, A1). On the receipt-to-main parse
   (2026-10-26..11-03, all three sections) the finder names `not-armed` on both bases; the lane section alone names
   `land-queue/lock-busy`, a section cut kept as a regression case. **Known limit:** the rule goes one step. A `review`
   or `gate` whose parent is a range that is critical only through its own-key slice is not critical, so if producers
   make ranges the parents of reviews, the critical basis does not see those review waits. AC 2 states the rule this
   way; story 12 may extend it to the parent's own-key slice (or the full ancestry) when such links exist. Owner seat and clear input are weighted by open waiting hours under the reason; with nothing open, the
   owner is the holder that waited longest in the 24 h and the clear input is null. Ties go by name, ascending. Until
   story 13 routes reasons, the owner seat is a holder, not a routed seat.
3. **Trend.** `up` above +20% of the previous window, `down` below -20%, else `flat`; `new` when the previous window
   measured no wait; `unknown` when the ledger's history (its earliest item) starts after the previous window began.
   The constraint shows the 24 h trend.
4. **Anomalies** (architect ruling, story 03 consult). Each names its measured value, its unit and its threshold;
   `value: null` with a `reason` when an input is missing. Outcomes are read from the close `state` only, never from
   attrs: producers (stories 02, 09, 10) send that one encoding. Producer silence is keyed per (producer, item type),
   because its threshold is per type: keyed per producer, a long-lived lane `slice` (fewer than 20 closes in 7 days,
   so never judged) became the producer's longest-silent item once a breached review closed, kept the producer's
   raised flag from clearing, and muted every later silence of that producer (architect CONCERN 03-C1, probe in
   `tests/unit/lib/constraint-flags.test.ts`). Per type, an unjudgeable slice holds only its own subject. If story 02
   ever closes 20 or more slices in 7 days, the lane slices would breach permanently; `slice` then leaves the silence
   types (an amendment of ruling 6).

   | Id | Measure | Threshold |
   |---|---|---|
   | `re-gates` | gates opened in 24 h on a `tree12` a gate closed `pass` earlier with the same or a wider `attrs.mode` (full covers affected; no mode matches the tree alone; `reused` never counts); also the share of gates | 0 |
   | `rework-rate` | ranges closed in 24 h with a `rework` wait / ranges closed | 10%, flagged only from 10 closed (`n<10`) |
   | `context-per-call` | each open seat's latest `attrs.contextTokens` | `attrs.rotateAtTokens`, else 300,000 (ADR-HFL-04) |
   | `wakes-per-hour` | per tab: `tab_events` delivered in 6 h, class not `log`, one per `digest_id`, / 6 | 6/h |
   | `unknown-share` | `unknown` / all waiting hours on `range`, `deploy`, `owner-issue`, 24 h | 5% |
   | `producer-silence` | open `slice`, `gate`, `review`, `landing` items with no wait: now - last event, one row per (producer of the item's last event, item type), subject `<producer>/<type>`, naming that pair's longest-silent item: `<item> silent for <n> min (threshold <t> min)` | max(10 min, 2 x the type's 7-day p90 lifetime); unknown and never flagged under 20 closed of the type |
   | `cost-per-landed-item` | spend over the last 7 UTC days / ranges closed `landed` over the same days (`ledger-store.landedRanges`: the landings the store's projection applied, `close` with state `landed` on a `range`, read through `getFinderSpend`; amended by harness-flow-loop 04); a partial spend index notes its reason | none: reported, never flagged |
   | `cache-read-per-landed-item` | `cache_read_tokens_per_landed_item` (harness-flow-loop 04, ADR-0030 amendment): cache-read tokens over the same 7 UTC days / the same landed ranges, from `getFinderSpend`; not measured carries the metric's reason | none: reported, never flagged |
   | `owner-found-defects` | `owner-issue` items raised in the last 7 d / 7, open or closed; raised = `attrs.raisedAt` (epoch ms, at most `opened_at`), never the time the feed first saw the row (harness-flow-loop 35, consults Q1 and Q2, round 2). Unknown, in this order: no `owner-issue` item (`no owner-issue item in the ledger`); the producer of the last event of the newest item (by raised time) received no event of any type in 24 h (`owner-issue producer silent`); that producer's first event was received under 7 d ago and no `owner-issue` item was raised or opened at or before the window's start (`window not covered`); an item opened inside the window, or still open, has no `raisedAt`, or no `owner-issue` item in the workspace carries one (`owner-issue raised time missing`); such an item carries a `raisedAt` that is not a positive safe integer at most its `opened_at` (`owner-issue raised time unreadable`) | none: reported, never flagged (the limits live in the improvement seat's candidate table) |

5. **Missing inputs** are `unknown`, never 0: `inputs.{ledger,flow,spend,pool}` each carry `state` (`ok`, `partial`,
   `stale`, `unknown`), `reason` and `at`. The ledger is `unknown` when it cannot be read (`ledger unreadable`) and when
   it holds no event for the workspace (`the ledger holds no event for this workspace`: no producer has spoken, which is
   not "nothing waited"). Then the answer has no constraint, no stuck item and no window, every anomaly reads `value:
   null` with that reason and its constant threshold, the line says the constraint is unknown, and the text form
   prints `stuck: unknown (<reason>)` and `anomalies: unknown (<reason>)`, never 0. A consumer (story 08's status push) reads
   `inputs.ledger.state`, never an empty list, to tell "not measured" from "nothing stuck". No flow record, a spend index
   that is `indexing` or `unavailable`, and no pool (none is published until ADR-HFL-09's scheduler) each read
   `unknown`; a flow older than 10 min reads `stale`; a ready spend index that reports an error reads `partial`.
6. **Tick.** One 60 s interval per process (`globalThis.__ptConstraintTick`, started beside the flag tick, stopped in
   `shutdownWs`) reads each workspace's inputs (`LedgerStore.finderSnapshot`: 14 days of waits, open items and items
   closed in 14 days, the producer of each open item's last event, the earliest item, deliveries per tab in 6 h) and
   caches the answer per workspace (`__ptConstraintCache`). The spend view (`by=workspace`, last 7 UTC days) and the
   pool are read once per tick, not once per workspace. A tick over 5 s logs its duration; the next is skipped while one
   runs (the ADR-0032 pattern); a workspace whose derive takes over 1 s logs its own duration. A read for a workspace the
   tick has not reached derives it at once, and concurrent reads share that one derive (`__ptConstraintInflight`).
7. **Board read.** `GET /api/cli/workspaces/{ws}/board` (read scope; `?mine=1` keeps the stuck items the calling tab
   holds, by name or id, and needs a tab token), `GET /api/mission-control/board?workspaceId=all|WS` (human session)
   and `purplemux board show -w WS [--json|--line|--mine]`. The board is the cached answer plus `workspaceId`, `ageMs`
   and `needsYou` (Mission Control's open items, id and title, oldest first; null when the store is unreadable).
   Every answer carries its age (`ageMs`) and `staleSince`: the answer's `generatedAt` when it is older than two ticks
   (120 s, `FINDER_STALE_MS`), else null. A consumer (stories 08 and 12) treats such an answer as stale, as the flag
   tick does: a hung tick leaves the cache in place with `inputs.ledger.state: ok`. `--line` and the text form then
   end the line with `stale since <time>` (AEDT/AEST).
   `onTrack.goal` is null until story 12's `board goal set`; with no goal `onTrack.state` is `at-risk`, so a consumer
   never reads "on track" against nothing. `--line` prints `goal · items left · constraint · trend`. The owner reads
   words, never tokens: `constraint.labels` and `stuck[].reasonLabel` come from one module
   (`src/lib/constraint-labels.ts`, the status push's wording), and `line` and the text form use only them; JSON
   consumers keep the tokens. `stuck` holds the 50 oldest waits, capped after the `--mine` holder filter; `stuckTotal`
   says how many matched, and the text form prints `50 of N`.
8. **Flags.** Each breached anomaly reaches the ADR-0032 tick as source `ledger` (`TAlertFlagSource`), rule the
   anomaly id, subject its seat, producer or `workspace`, and names the workspace's orchestrator until story 13 routes
   it. A workspace with no cached answer, whose ledger is `unknown`, or whose answer is older than two ticks (120 s) is
   an unread source (`ledger:<ws>`): its ledger flags neither raise nor clear, and the per-source baseline applies.
   Each anomaly subject is also its own source (`ledger:<ws>/<id>/<subject>`), failed while the anomaly cannot be
   judged (`judged: false`: value or threshold null, or a measure that never flags, such as rework under 10 closed),
   so an anomaly that turns unknown never clears a raised flag; a subject the finder stops reporting is forgotten.

9. **Pulse** (story 12 AC 10, the owner's ask of 2026-11-03: "I need hourly feedback on how things are going and what
   is priority"). `derivePulse` in `src/lib/pulse.ts` (pure) buckets movement events into the 48 clock hours ending now
   (UTC hours align with AEDT/AEST hours), served by `GET /api/mission-control/pulse?workspaceId=all|WS`,
   `GET /api/cli/workspaces/{ws}/pulse` and `purplemux board pulse -w WS [--json]`, cached 60 s per workspace
   (`__ptPulseCache`, concurrent reads share one derive). It works before the ledger has producers.
   - *Scope: every movement event belongs to exactly one workspace* (round 2, F1; `src/lib/pulse-scope.ts`). A workspace
     whose tab holds an `epic:<slug>` lease (`leases.json`, live or not) owns that epic's `_output/<slug>/` gate logs and
     review records, the repositories its `status.yaml` names with an `integration_branch` (that exact branch and each
     story's exact branch, `stories[].branch`, else `story/<key>`: never a `story/*` wildcard, which counted another
     epic's stories on a shared repository, round 3; a repository listed only for briefs, such as treasury-v2 in
     harness-flow-loop, is not its own; the v1 format's top-level branch with `stories[].repo` resolves the same way),
     every directory whose `.v2/status.yaml` names the epic (its `main`, gate logs, receipts and landings), its own
     ledger rows and its own Mission Control answers. Where two leased epics share a repository, each commit counts for
     exactly one: a commit only one epic's refs reach is that epic's; one both reach belongs to the epic whose story
     branches hold it when the other's do not (the epic it was committed on); any other, such as a commit on both
     integration branches, counts for neither and is shown once as shared with the other workspace. A
     workspace with no epic lease counts its own directories, minus whatever another workspace's epic covers; a
     directory another workspace lists too is read as a source labelled "shared with <ws>", shown and never counted in
     the bars or the stall. `status.yaml` is read line by line for those keys only (no YAML dependency).
   - *Filesystem bound* (architect CONCERN C1; `src/lib/pulse-fs.ts`). A deadline abandons a hung read's promise, not
     its libuv worker, and the server's async fs (tab status, session parsing, static files) shares one threadpool of
     4 workers. Every pulse fs call on a `fuse.sshfs` mount (from `/proc/mounts`: `_output` is sshfs from ai-server) goes
     through one process-wide limiter, at most 2 in flight, a slot freed only when the call itself returns. The mount
     list is re-read when older than 60 s, so a mount that comes up after the server started is guarded from then on
     (confirm r2, F1). A call that waits 5 s for a slot is never issued and reads "<mount> busy": a queue wait never
     opens the breaker (F2). A call that runs 5 s, timed from when it left the queue, opens that mount's breaker: no new read is issued
     there until one probe `stat` of the mount returns, and the sources that read it are "not measured: <mount> not
     answering since <time>", never absent. So a dead ai-server holds at most 2 of the 4 workers, and the server's
     other fs calls keep the other 2 (tested with a real never-returning read, a FIFO with no writer, against an
     unrelated local `stat`). `UV_THREADPOOL_SIZE` is unchanged. Only the leased epics' `_output/<slug>` paths are read
     (the fallback's scan of every `_output/*` entry is gone), a finished gate log is never read again, and a review
     record's mtime is read once.
   - *Sources*, each read on its own behind a 10 s deadline (`PULSE_READ_DEADLINE_MS`; past it, that source is
     unknown "read timed out"; a derive still running at the deadline is no longer shared with the next reader); one
     that cannot be read is `unknown` with its reason and `count: null`, never a zero bar:
     ledger (`open`, `clear`, `close` events on `range`, `slice`, `gate`, `review`, `landing`, `deploy`; experiment,
     seat and MC item events never count, round 2 F2); commits on the scope's refs (lane branches are never read:
     rebases re-create their commits, 2,255 commits in 48 h across every treasury-v2 branch against 685 on main,
     2026-11-03); gates finished (library `gate.sh` logs: the `VERDICT=` word up to a space or bracket, `VALID` with
     `EXIT=0` a pass, `RED` a fail, any other word such as `VOID-UNSETTLED`, `REFUSED-*`, `KILLED*`, `STOPPED` not a
     finished gate (F3); v2 `.v2/gate-logs/*`: the `GATE PASS|STEPS-PASS|FAIL` line that names the file itself, since a
     tools test prints stub verdicts inside a log); review rounds and confirmations (v2 receipts, one per passed round,
     and every library `_output/<epic>/reviews/*-out.md`, F6; a v2 BLOCK round writes no record, so those are seen only
     once story 02 emits them); v2 `LANDED` lines; Mission Control answers. A finished log's verdict is read once per
     (size, mtime) from an LRU of 20,000 entries (F12).
   - *Work in progress* (architect consult 12, Q1): the ledger's open work items once it holds a work-item event for
     the workspace in 7 days; else the busy or needs-input agent tabs (the orchestrator left out: it turns on every
     nudge; an open but idle tab is not work, as treasury-v2 keeps idle lane tabs) plus the open MC items; else not
     measured. The two bases never mix. A tab waiting for input is stuck from when it began waiting and may be named
     the oldest stuck item; a busy tab is working and never named (F10). The orchestrator is left out while it is
     busy (it turns on every nudge) and counts while it waits for the owner: a pane prompt, or a current
     `NEEDS-DECISION:` or `BLOCKED:` turn end. It is then the stuck item named with its question, never grey idle (C2).
   - *Stall marker*: `stalled` (red) when WIP > 0 and nothing moved for 2 h, naming the counted item with the oldest
     `since`; `moving` (green) when the last 60 min moved and is at or above the median of the active hours (any event)
     among the 168 complete clock hours before the current one (round 3, F13: a median over every hour is 0 for a
     workspace idle most of the week; the reason names the basis, "median of active hours 6/h"); `idle` at a measured WIP of 0; `steady` otherwise; `not-measured` without a basis, and
     whenever no file-born source (commits, gates, review rounds, landings) was read: the ledger and MC answers alone
     never decide a stall (F4). Every reason names the sources that were not measured.
   - *Priority now*: the constraint with its owner and clear input; with no constraint, the oldest stuck critical
     item; and the needs-you count. A finder answer older than 120 s makes the pulse say "stale since <time>", and the
     pulse header turns amber "stale since <time>" once its oldest answer is older than 120 s (F5).
10. **The board view** (story 12). `/mission-control` defaults to `?view=board`: the pulse rows (every workspace,
    first), then the selected workspace's sections in ADR-HFL-02 order (on track, constraint, needs you, stuck, flow by
    stage with the flow panel and burndown, experiments, seats with the spend tile, pool). `?view=answers` is the answer
    list and `?item=<id>` opens it on that card; the portfolio board keeps its own view and loses the burndown and the
    spend tile. Each section shows its data age, "stale since <time>" when its source is stale; one column below 600 px;
    SWR polls both reads every 30 s while the page is visible. The view sends no write.
    - *Goal*: `purplemux board goal set -w WS --items KEY,KEY --label TEXT` (own workspace only) writes
      `workspaces/{ws}/board-goal.json`; the tick passes it to `deriveConstraint` (a new optional input), and a write
      drops the cached answer. `onTrack.goalState` is `set`, `none` or `unknown`: an unreadable goal file reads "goal
      not measured: <reason>", never "no goal set" (F7). A goal has no due date, so the view names an `on-track` line
      "Forecast (no due date set)"; `onTrack.state` keeps its two values for story 08 (F9). `onTrack.itemsLeft` counts goal keys the ledger does not hold closed (the finder reads 14
      days of closes, so an older close counts as left); `p50At`/`p90At` come from an exact bootstrap over the last 3
      days' closes of the goal keys' item types (`src/lib/board-forecast.ts`, pure): no close in 3 days is no forecast
      (`reason`), never a date; with a forecast the line is `on-track`. No model writes a number.
    - *Needs you blocks*: `needsYou[].blocked {items, hours, critical}` per ADR-HFL-11 §1: the open items waiting
      `owner` whose link (parent) is `mc-item:<id>`, computed by the finder as `ownerBlocks`. The faces keep two facts
      apart (F8): an unmeasured ledger reads "blocked cost not measured: <ledger reason>"; a measured ledger with no
      item linked reads "no ledger item links to this item".
    - *Critical marks*: the board keeps §2's one-step rule. No producer links a review or gate under a range (story 02
      links fold members to their fold slice, which the own-key rule covers), so the full chain would mark nothing more
      today; when a producer does, extend `criticalKeys` to the parent's own-key slice with a test.
    - *Not measured until their producers land*: per-seat cost per day (story 04), the pool (ADR-HFL-09), seat context
      and wakes (stories 09, 10), and every ledger section until story 02.

## Consequences
- One read answers "where is it stuck, why, who holds it, what clears it" for every workspace, the same numbers for
  the web, the phone, the status push and the improvement seat.
- The tick costs one ledger snapshot per workspace a minute. On story 01's synthetic 92-day file (14-day read: 147,681
  intervals, 35,006 items) the snapshot takes 175-277 ms and the derive 173-266 ms, synchronous on the event loop; the
  14-day read is bounded by the `(workspace_id, end, start)` index, and the items read scans the workspace's items.
- Anomalies that rest on producers not yet live (seat context, tab events, gate verdicts) read `unknown` until stories
  02, 09 and 10 land; they never read as healthy.

- The pulse costs one read of each source per workspace a minute: 10-401 ms per workspace across the four live
  workspaces (2026-11-03 09:50Z, `evidence/12/pulse-live-r4.json`). On the `_output` sshfs mount that is 47 calls a
  minute once warm, 838 in the first minute after a start (every finished log read once), against about 1,400 a
  minute before the C1 fix (architect estimate). The synchronous part (the SQLite reads and the derives) holds the
  event loop 46-134 ms per pulse (review round 1 measurement). The pulse is the server's first periodic reader of a
  network mount, which couples it to ai-server: a hung mount read keeps a threadpool worker blocked whatever its
  deadline, so the limiter caps the pulse at 2 of the 4 workers and the breaker stops new reads there until the mount
  answers. A dead ai-server then turns those sources "not answering" and leaves the server's other fs calls served.

## What proves it wrong
Replay 2026-10-27..11-03 at 60 s ticks with one gate producer killed mid-run: producer silence flags more than one
normally-closing item a day, or misses the killed gate within its threshold, or re-gates breach on every tick of the
week (then the threshold moves to story 20's 1.3 gates per landing). For the board as a whole: status and ETA asks do
not fall below 1 a week within 14 days of the board, or the owner names a stuck item the board did not show. For the pulse: over 7 days of harness-flow-loop and treasury-v2,
a window of 2 h or more with no movement, a story `in-progress`, no busy or needs-input worker tab and no open MC item
(workers idle after DONE, the orchestrator stuck) reads `idle`, not `stalled`: idle story-worker tabs must then count.

## Amendment (2026-11-03, story 13: alarm routing)

§2's owner seat stays the heaviest holder: a routed seat is a delivery fact, not a finder measure, and the finder
stays pure of fleet config. §8's "names the workspace's orchestrator until story 13 routes it" is replaced: a ledger
flag names the tab `ledger.route.<ws>` routes its anomaly id to, with `$holder` read as its subject seat, and the
orchestrator for an id the table does not name (ADR-0032, amendment of 2026-11-03). The flag tick also reads the
cached answer's `stuck` list, uncapped, for item alarms; `stuck` therefore stays the full list of open waits, and
only the board read caps it at 50. `FINDER_ANOMALY_IDS` is exported for the route table's pattern check.
