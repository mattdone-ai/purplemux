# ADR-0033: The work-item ledger and the closed wait-reason vocabulary

## Status
Proposed (2026-11-03, epic `harness-flow-loop`, story 01). The epic's ADR-HFL-01, landed in purplemux.

## Context
The receipt-to-main wait is the largest share of lane lead time: 60% (p50 1.7 h, p90 11.8 h; the epic's evidence
pack). No store says why a range waits. The flow snapshot (ADR-0026) holds queues and meters with no per-item history,
and its server history keeps aggregates only (2,000 rows). The chain logs hold the facts as free text, more than 77,000
lines a day, and their states parse only with judgment. Every later change in the epic is to be judged on one measure:
how long each work item waited, and why.

## Options considered
1. **A `waiting_on` field per flow item.** Cheap; but a snapshot a minute loses sub-minute transitions, and per-item
   history would grow the record past its 4 MiB bound.
2. **A producer-local event log read by the producer's scripts.** Fast to build; but there would be one per workspace,
   and ADR-0026 rules that the harness never reads a producer's files.
3. **An append-only event store in purplemux, pushed by producers, with server-side derivation.**
4. **A table inside `mission-control.sqlite`.** One file; but it couples a high-volume feed to the attention store's
   schema version (the ADR-0023 rollback lesson).

## Decision
Option 3.

1. **Store.** `~/.purplemux/ledger.sqlite` (`src/lib/ledger-store.ts`): better-sqlite3, WAL, `synchronous = FULL`,
   0600, `user_version` 1; a newer version is refused. Tables:
   - `events(seq, event_id, workspace_id, at, received_at, producer, item_type, item_key, kind, state, wait_reason,
     holder, clear_input, parent_key, attrs_json, event_key, body_digest)`, append-only. The id is producer-chosen and
     idempotent, so a replayed batch or spool never counts twice. ADR-HFL-01 said `event_id UNIQUE`; the unique column
     is `event_key`, 12 bytes of SHA-256 over the workspace, the producer and the `event_id`: one producer's retransmit
     is a duplicate, two producers' equal ids are two events, and one workspace's ids never mask another's. A unique
     index on the text pair was 112 MB of the 611 MB synthetic file (story 01, first run); the hash index costs about a
     third of that. `body_digest` (8 bytes of SHA-256 over the event body, attrs keys sorted) tells a retransmit from a
     reused id: the same key with another digest is refused 409 `ledger-event-conflict`, naming the `event_id`, and the
     batch stores nothing.
   - `items(workspace_id, item_key, item_type, opened_at, closed_at, state, state_since, wait_reason, wait_since,
     holder, clear_input, parent_key, attrs_json, last_seq, last_event_at)`: the projection.
   - `intervals(id, workspace_id, item_key, item_type, reason, holder, start, end)`: one row per finished wait,
     written in the transaction of the event that ends it, so a read is a sum, never a replay.
   - `rollups_daily(workspace_id, day, item_type, reason, waited_ms, items, p50_ms, p90_ms)`.
   - `tab_events(seq, workspace_id, tab_id, at, class, kind, text, delivered_at, digest_id)` (ADR-HFL-05; its writer,
     and the two columns it adds, are ADR-0035) and `experiments` (ADR-HFL-03). `ledger_meta` keeps the rollup progress and each workspace's
     longest interval, which bounds every window read on both sides of the `(workspace_id, end, start)` index.
2. **Vocabulary** (`src/lib/ledger.ts`, closed; a change is an amendment of this ADR, never a producer decision).
   - Item types: `slice`, `range`, `gate`, `review`, `landing`, `deploy`, `owner-issue`, `mc-item`, `seat`,
     `experiment`. An `item_key` is `<item_type>:<id>` (for example `range:<lane>:<key12>`, `gate:<tree12>:<started>`).
   - Kinds: `open`, `state` (a new state, no wait), `wait` (a reason, a holder, a clear input), `clear`, `close`
     (terminal), `link` (a parent).
   - Wait reasons by stage: `build-review` review-queue, review-findings, rework, receipt-rekey; `land` not-armed,
     pre-arm-gate, fold-batch, own-lane-order, group-partner, guard-hold, gate-slot, pre-flight-gate, land-queue,
     lock-wait, under-lock-gate, red-main, chain-down; `deploy` deploy-queue, deploy-run, deploy-auth, external-team;
     `people` owner, agent-idle; `hosts` host-load.
   - Derived only: `land-queue/lock-busy`, `land-queue/head-blocked`, `unknown`. A producer that sends one, or any
     other reason, gets 400 `ledger-reason-invalid` with the list.
3. **Derivation** (per item, in the event's transaction; ruled by the architect seat at xhigh, 2026-11-03):
   1. `wait` ends the open wait (its interval is written) and opens the new one. If the reason and the holder match the
      open wait, the event continues it, so a producer that re-sends a wait every minute cannot split it.
   2. `state`, `clear` and `close` each end the open wait; the item then has no wait.
   3. `unknown` applies only to the item types whose whole open life is waiting, `LEDGER_UNKNOWN_ITEM_TYPES`:
      `range` (receipt to LANDED, the population of the falsifier below), `deploy` and `owner-issue`. For them, before
      an event is applied, if the item had no wait and `at - last_event_at > 10 min`, the whole gap [`last_event_at`,
      `at`) is written as an `unknown` interval; a gap of 10 min or less counts nowhere; at read time an open item with
      no wait, silent for more than 10 min, is open WIP `unknown` since its last event. Write and read share one
      predicate. For every other type (`slice`, `gate`, `review`, `landing`, `mc-item`, `seat`, `experiment`) time with
      no open wait is work, a hold or a record's life: it is never waiting and writes no interval. Silence on those
      types is the finder's "producer silence over 10 min" anomaly (ADR-HFL-02 §1), not waiting hours; counting it would
      put a gate's run, a landing's hold and the server's own experiments into the unknown share, which no producer fix
      could bring under 5% (architect confirmation, story 01). No other type of the ADR-HFL-01 list spends its whole life
      waiting: a `review` is queued and then worked, and an `mc-item`'s owner wait is already recorded on the items it
      links. A change to the list is an amendment of this ADR. A known wait is never `unknown`, however long it is
      silent.
   4. `open`, `state`, `wait`, `clear` and `close` move `last_event_at`; `link` does not.
   5. `land-queue` is counted as `land-queue/lock-busy` while the workspace has an open `landing` item and as
      `land-queue/head-blocked` while it has none. A landing that opens or closes ends the segment of every land-queue
      wait in the workspace and starts the other half.
   6. Time never runs backwards for one item: an event is applied at `max(at, last_event_at, wait_since)`, so no
      interval is negative or overlaps another of the same item, and a closed item's intervals never exceed its
      lifetime. A landing resplit moves each split item's `last_event_at` to the split, so a late event for that item
      lands at the split, not before it (story 01 review round 2, finding F1).
   7. An event for a closed item is stored and changes nothing, except an `open` with `at` after `closed_at`, which
      reopens it from that `at`; a late open does not reopen the item in the past. Only an `open` creates an item: any
      other event for an item the store does not hold, never opened or deleted by retention, is stored as an event
      only and counted as `orphan`, so a late event can never recreate a deleted item as a ghost. An event older than
      the 92-day retention cutoff is refused at parse time (`ledger-event-invalid`).
   8. Derivation is at write time, in arrival order. When a producer's spool drains after an outage, its late events
      are applied after another producer's on-time ones; the clock floor keeps every item's total exact, but time
      inside the outage window can be attributed to the earlier reason (architect probe P3: a 15-min `lock-wait` read
      as `not-armed`). Accepted: it occurs only inside an outage window, and replaying derivation on reads would trade
      it for the per-read cost this store exists to avoid.
4. **Transport.** `POST /api/cli/workspaces/{ws}/ledger/events`: 1 to 500 events, at most 1 MiB; one refused event
   refuses the batch. `at` more than 5 min after receipt, a control character in any string or a format or bidi
   character in an identifier is refused with the ADR-0026 rules (`IDENTIFIER_REFUSED`, `PROSE_REFUSED`, shared from
   `src/lib/flow.ts`). A refusal names the field, the value (escaped) and what was expected. The item types the
   server writes itself, `experiment`, `seat` and `mc-item`, are refused from a producer token: 403
   `ledger-type-reserved`, naming the type.
5. **Credential.** `purplemux ledger token issue -w WS --producer NAME` asks the server (own workspace only) for a token
   with the single scope `ledger:emit` on that workspace and writes it to a 0600 file. The server keeps a SHA-256 in
   `~/.purplemux/ledger-tokens.json`; issuing a producer again rotates its token. The token is not a CLI token:
   `resolveCliScope` never matches it, so every other route answers 401 or 403 (proved by a test that enumerates every
   `/api/cli` route file). The events route takes only a ledger token of its own workspace. The producer name comes
   from the token and must be a file-name slug, because it names the spool file. The server's own producer name,
   `purplemux` (and any `purplemux:` name), is reserved: a token under it could pre-claim the event ids of the
   server's experiment events.
6. **CLI emit.** `purplemux ledger emit -w WS --token-file F --json @-` sends `~/.purplemux/ledger-spool/<producer>.jsonl`
   first, in order, then the new events. On a connection failure, no answer in 5 s, a 401, 403, 404 or 5xx it appends
   what it did not send to the spool and exits 0: a producer never fails a landing, a gate or a chain because the
   ledger is down. A refusal (400, 413, 403 `ledger-type-reserved`, 409 `ledger-event-conflict`) moves only the event
   it names (`events[i]`) to `<producer>.rejected.jsonl` and sends the rest of the batch again, in order, so one bad
   event never blocks the spool or drops its neighbours; a refused new event also sets the exit code. One drainer per
   producer holds a drain lock and refreshes its mtime before every batch (stale after 60 s); every change to the spool
   file, an append included, takes a short file lock, and the drainer keeps whatever was appended while it sent. A
   torn last line (a crash mid-append) is dropped; any other line that is not JSON stops the drain, keeps the file and
   names the line number on stderr.
7. **Reads** (read scope: own token, peer, grant, admin; `Cache-Control: no-store`). `GET .../ledger/items?open=1&type=
   &holder=`; `GET .../ledger/waits?since=&until=&by=reason|holder|type|stage&type=` (`type` limits the answer to one item type; since no older than the 92-day
   retention limit, or 400 `ledger-query-invalid`: deleted waits must not read as no waiting) answers, per group, the finished waits
   clipped to the window (summed ms), p50 and p90 (nearest rank) of the waits that ended inside it, and open WIP
   (items waiting now whose wait began before `until`, with their elapsed wait clipped to the window, reported apart
   from the sum); `GET .../ledger/experiments`. CLI: `ledger show`, `ledger waits`, `ledger experiment open|close|list|extend`.
8. **Experiments** (ADR-HFL-03 point 3): the server assigns `EXP-<n>`, opens the item `experiment:EXP-<n>`, and holds
   one active experiment per stage and at most two in all (409 `ledger-experiment-cap`). A close takes a verdict, keep
   or revert, and evidence, and closes the item.
   *Amended 2026-11-03 (harness-flow-loop story 22, "extend once" in ADR-HFL-03 decision 2 step 1):* an active
   experiment can be extended once: `POST .../ledger/experiments/<id>/extend {days, evidence}` (CLI
   `ledger experiment extend`) adds `days` to `max_days`, at most to 90 (409 `ledger-experiment-cap`, field `days`). A
   second extension is 409 `ledger-experiment-extended`; a closed experiment is 409 `ledger-experiment-closed`. The
   record gains `extended_at`, `extension_days` and `extension_evidence` (columns added on open of an older ledger;
   `user_version` stays 1), and the item gains a server `state` event `extended`. The board's experiment line says
   "extended once".
9. **Retention.** A daily job (`src/lib/ledger-retention.ts`, first pass 10 min after boot) rolls up into
   `rollups_daily` every whole UTC day from the day after the last rolled-up day, or from the earliest day a wait
   finished since the last pass covers, whichever is earlier, to yesterday (never before the cutoff). A wait longer
   than a day thus re-rolls each day it covers once it finishes, every day is rolled with its finished waits before it
   leaves the window, and a server down for days leaves no gap. It then deletes events and intervals older than 92 days
   (the ADR-0030 spend floor), tab events older than 30 days (ADR-HFL-05 decision 3; amended by ADR-0035), items
   closed before then, and rollups older than 400 days. Each day's rollup is one transaction and each delete runs in
   chunks of 5,000 rows, yielding to the event loop between them.

   | Table | Kept |
   |---|---|
   | `events`, `intervals`, closed `items` | 92 days |
   | `tab_events` | 30 days |
   | `rollups_daily` | 400 days |

## Measured (story 01)
A synthetic load of 15,000 events a day for 92 days (1,380,000 events; ranges, gates, landings and seat events with
attrs; 969,720 intervals; 230,006 items), built on local disk, measured 2026-11-03. Round 2 adds `tab_events` at the
ADR-HFL-05 rate (18,026 orchestrator inputs in 14 days: 1,300 a day, 119,600 rows, one in 50 a digest of up to 2 KB) and
times 7-day windows ending now and 30, 60 and 84 days ago, the JS aggregation included (7 runs per window and `by`).

| Schema | File | 7-day `waits` |
|---|---|---|
| first cut: `UNIQUE (workspace_id, event_id)`, `items(workspace_id, closed_at)`, a cross-workspace `intervals(end)` index, object rows with `ORDER BY`; no `tab_events` | 610,775,040 B | recent window only: median 157-176 ms, slowest 302 ms |
| round 1: `event_key` hash, partial open-items index named by `INDEXED BY`, `(workspace_id, end)` only, raw rows; no `tab_events` | 514,859,008 B | recent: median 64-73 ms, slowest 86 ms; ending 30-84 days ago: cold first run 726-770 ms (unbounded `end > since` scan) |
| as decided: round 1 plus `body_digest`, `(workspace_id, end, start)` bounded by the longest interval, `tab_events` loaded | 571,195,392 B (414 B an event) | every window: median 49-98 ms. Slowest of 112: 70.5 ms in an earlier run of the same structure (16-byte key), 317 ms with the host at load 48-56 on 32 threads |

Targets: under 600 MB and under 200 ms. A first retention pass over 92 unrolled days took 5.8-9.5 s, in 92 day
transactions and 5,000-row delete chunks, yielding to the event loop between them.

## Consequences
Every later change is judged on one measure. Producers change in their own repositories and in purplemux; no LLM types
a state. The vocabulary is small enough to read on a phone and fixed enough to compare week on week. A chain-log line
stays the human log; the event is the record. The board shows the `unknown` share; above 5% of waiting hours it is a
producer defect, fixed by a producer, not by a new reason.

## What proves it wrong
After 7 days of live producers, the `unknown` share stays above 5% of waiting hours, or the summed waits per range
differ from receipt-to-LANDED wall time by more than 5% on 20 sampled ranges.
