# ADR-0030: Spend read model — tokens and estimated cost per workspace, tab, day, model and role

## Status
Proposed (2026-10-26, epic `purplemux-flow`, story 07).

## Context
The owner asked where the tokens went. `GET /api/stats/overview` aggregates Claude usage per day and model only
(`src/lib/stats/stats-cache.ts`); no stats code knows a workspace, a tab or a role. Measured on 2026-10-26:
- Workspace attribution is exact for Claude: each workspace's transcripts live under
  `~/.purplemux/workspaces/{ws}/claude-home/projects` (`listClaudeProjectsDirs`).
- **Subagent transcripts are not counted anywhere.** `collectJsonlFiles` reads only the top level of each project and
  skips `agent-*.jsonl`. Claude Code writes subagent transcripts to `<project>/<sessionId>/subagents/agent-*.jsonl`:
  2,669 files and 3,752 MB, against 389 main files and 3,059 MB. Each subagent line carries the parent `sessionId` and
  `isSidechain: true`. (Bytes measured; the token share is not measured.)
- Tab attribution needs a session-to-tab binding. Session history keeps 200 entries fleet-wide
  (`src/lib/session-history.ts:10`), a few hours of a 50-tab workspace. The server learns every binding in two layout
  writers, `updateTabAgentSessionId(sessionName, provider, sessionId)` (`src/lib/layout-store.ts:655`; the timeline
  server and tab create) and `updateTabAgentState` (the status manager's hook, launch and poll saves), and forgets it
  at the next session.
- Codex sessions live in the global `~/.codex/sessions`, so even the Codex workspace needs the binding.
- The transcripts total about 6.8 GB; one Node process serves every request, so a full parse per request is not possible.

## Options considered
1. **Extend the stats cache with workspace and tab keys.** One cache; but its unit is a whole day reparsed, its version
   bump drops every user's cache, and it would still miss subagents.
2. **Parse on request with a cache keyed by file size and mtime.** Simple; the first request after a deploy blocks the
   event loop for minutes.
3. **A separate incremental index built in the background, one shared usage extractor, and a durable binding store.**

## Decision
Option 3.

1. **One extractor.** `readClaudeUsage(entry)` in `src/lib/stats/claude-usage-line.ts` (new) returns `{messageId, model,
   sessionId, sidechain, day, input, output, cacheRead, cacheCreation, cacheCreation5m, cacheCreation1h}` or null, with the
   stats cache's rules (model present and not `<…>`, usage present, `day` = the UTC date of `timestamp`). `parseDaysFromFile`
   is refactored to call it; its existing tests pin that the stats answer does not change.
2. **Files.** Claude main files are `collectJsonlFiles()` (unchanged). Claude subagent files are
   any `.jsonl` below `<project>/<sessionId>/subagents/`, at any depth (new collector; workflow agents write
   `subagents/workflows/<wf>/agent-*.jsonl`). The workspace is the one whose `claude-home/projects` holds
   the file; `~/.claude/projects` is the workspace key `global`. Codex and Grok files come from their existing readers.
3. **Bindings.** `~/.purplemux/session-tabs.json` (new, 0600, tmp + rename, one lock): `{version: 1, bindings:
   {"<provider>:<sessionId>": {workspaceId, tabId, firstSeenAt, lastSeenAt}}}`. Both session-id writers,
   `updateTabAgentSessionId` and `updateTabAgentState`, record each non-null session id they are given after their
   layout write, so a tab made after boot and the new session of `tab restart --clear` bind at once; a known binding is
   rewritten at most once an hour; a failure is logged and never fails the hook path. At start the store is
   seeded from session history and from every layout's current session ids. Bindings last seen before the spend floor (§4 Retention) are pruned.
4. **Index.** `~/.purplemux/stats/spend-index.json` (new, version 1, 0600). Per file: `size, mtimeMs, ino, offset` (the
   end of the last complete line read) and buckets `{day, model, sessionId, sidechain, input, output, cacheRead,
   cacheCreation}`. A message id counts once per file (the stats rule); the index keeps the last 256 ids per file so a
   tail read does not count a message twice across a boundary. A grown file is read from `offset`; a shrunk file or a
   new inode is read again from 0. The indexer runs on `globalThis.__ptSpendIndexer`: it starts 120 s after boot, takes
   one file at a time, newest mtime first, yields with `setImmediate` every 1,000 lines, and JSON-parses only lines that
   contain `"type":"assistant"`. It writes the index at most every 60 s and at the end of a pass, then rescans every
   5 min. A request never parses a transcript. Codex and Grok session files are read again when their size or mtime
   changes; their usage counts on the session's start day (`dayBasis: 'session-start'`, an approximation the view states).
   **Retention.** The index keeps what it has read after a transcript leaves the disk (Claude Code's transcript cleanup,
   `cleanupPeriodDays`, default 30 days; a removed workspace's home). Each pass stats every indexed path the listing did
   not return. `ENOENT`/`ENOTDIR` marks the entry gone: `goneAt` is set, `recentIds` are dropped, buckets and usage are
   kept, and the file is never read again. A successful stat or any other error leaves the entry unchanged for that
   pass, so an I/O error never lowers a number. A gone path that is listed again is read again from 0, and its new entry
   replaces the kept one. The spend floor is today − 91 (UTC; 92 days, `MAX_SPEND_RANGE_DAYS`). A gone entry loses each
   bucket dated before the floor and is deleted when none is left. Entries of files on disk are never trimmed, and
   removing a workspace does not drop its entries. Gone entries are not counted in `filesIndexed`/`filesTotal`. A
   version bump migrates gone entries.
5. **View.** `ISpendRow {key, label, providerId: 'claude'|'codex'|'grok'|null, inputTokens, outputTokens,
   cacheReadTokens, cacheCreationTokens, totalTokens, sidechainTokens, costUsd: number | null, unpricedTokens}`.
   `ISpendView {workspaceId: string | 'all', from, to, by, generatedAt, totals, rows, unattributed: ISpendRow | null,
   roleBasis?: 'current-orchestrator', dayBasis: {claude: 'message', codex: 'session-start', grok: 'session-start'},
   index: {state: 'ready'|'indexing'|'unavailable', filesIndexed, filesTotal, indexedThrough: ms | null, error?}}`.
   `by` is `tab | day | model | role`, plus `workspace` on the all-workspaces human view. Days are UTC dates.
   Invariant, per `by` and per token field: `sum(rows) + unattributed = totals`. Usage whose session has no binding is
   `unattributed` (in its workspace when the path names one, else in the fleet total): never dropped, never 0.
   `role` rows are `orchestrator` (the tab that is the workspace's enabled orchestrator now) and `other`.
6. **Cost.** `calculateCost` / `calculateCostByFullId` (`src/lib/claude-tokens.ts`) per model. Tokens of a model with no
   price go to `unpricedTokens`; `costUsd` is the sum of priced tokens, and null when no token of the row has a price.
   The UI labels cost "est." and shows unpriced tokens beside it; it never prints $0 for an unknown price.
7. **Parity.** For each UTC day, the Claude non-sidechain tokens of the main files, summed over all workspaces, equal the
   stats cache's Claude tokens of that day. A fixture test runs both code paths over one tree. The spend view states the
   subagent share (`sidechainTokens`) separately, because the stats overview does not count it. Parity holds for every
   finished UTC day from the spend floor to yesterday, including days whose transcripts have since left the disk, as long
   as the index read them first. Today can differ: the stats cache recomputes today from the disk.
8. **Routes.** `GET /api/cli/spend?workspaceId=WS&since=YYYY-MM-DD&until=YYYY-MM-DD&by=…` (read scope on WS; default the
   last 7 UTC days, `by=tab`; a range over 92 days, a `since` before the spend floor, or a bad date → 400
   `invalid-request`).
   `GET /api/mission-control/spend?workspaceId=WS|all&period=today|7d|30d&by=…` (human session). Both answer
   `ISpendView`. `GET /api/mission-control/burndown` gains `tokensByDay?: [{day, totalTokens, sidechainTokens}]` for the
   burndown's workspace. CLI: `purplemux spend show -w WS [--since D] [--until D] [--by tab|day|model|role] [--json]`.
9. **Faces.** A Mission Control "Spend" tile (today and 7 d: tokens and est. cost; the top 5 tabs), and a tokens line on a
   second axis of the burndown chart. While `index.state` is `indexing`, the tile and the CLI show "indexing n of m
   files" and mark the numbers partial. The burndown omits `tokensByDay` while the index is not `ready` (§4.5 gives the
   burndown no index status), so its chart draws no partial line.

## Consequences
- The owner gets per-tab and per-role spend, subagents included, without a new transcript reader.
- Spend before the binding store existed is attributed to its workspace and shown as unattributed per tab; it never moves
  to a guessed tab.
- The first full index after the deploy takes minutes of background CPU; requests answer `indexing` until it ends.
- `GET /api/stats/overview` is unchanged; a later change may add subagent usage to it.
- Non-goal: budgets, spend alerts and cost caps.
- Spend keeps 92 UTC days whatever the transcript cleanup does; older days are refused, never shown as 0. The index is
  no longer purely derived: losing it loses the usage of transcripts already deleted (at most 92 days' worth).

## Amendment (harness-flow-loop 04, 2026-11-03): spend by seat, phase and item; cache reads on every face

**Context.** Cache reads are 55% of spend (the epic's audit), about 69 M cache-read tokens per landing (its research
§3.3), and no face showed them beside the total. Cost had no seat, no phase and no item. The index kept usage per UTC
day only, so no message could be placed in time; the work-item ledger (ADR-0033) now says which items a tab held when.

**Decision** (the phase contract is the architect seat's consult ruling, Opus 5.5 xhigh, recorded in the story).
1. **`by` gains `seat`, `phase` and `item`** on both routes and the CLI. Mission Control refuses `phase` and `item`
   with `workspaceId=all`: the ledger is per workspace.
   - `seat` = the tab name of the bound session: the open tab's name, else `tabName` recorded with the binding (§3
     gains `tabName?`: the name at the newest sighting that carried one, from both session-id writers and the seed; a
     sighting under a new name is written even inside the hourly touch interval), else `tab:<id>` labelled "closed,
     name not recorded". With `all`, keys are `<ws>/<name>`.
   - `phase` and `item` serve at most 7 UTC days (400 `invalid-request` naming the cap, on both routes): the replay
     below runs synchronously from `since − 7 d`, so a capped window scans 14 days of events. Measured (review,
     synthetic peak ledger, 15,000 events a day, host load 46-71): 210,001 rows, read in 431-666 ms, +147 MB heap, and
     about 1.3-1.5 s of event-loop stall with the fold; an uncapped 99-day window was about 8-9 s and over 1 GB. That
     is the bound the cap buys. It applies only on demand (an explicit `by=phase|item` request or `spend phases`); no
     face polls it. Any face that would poll `by=phase|item` must first move the replay to a yielding read (`.iterate()`
     with yields) or a per-day phase rollup: the cap alone does not make a polled read safe.
   - `phase` = the ledger item the tab held at the message's time, mapped by one fixed table; `item` = that item's key.
2. **Message time.** Claude buckets gain `slot`, the UTC 5-minute start (ms); the bucket key is `(day, model,
   sessionId, slot)`. A live entry without `slotted: true` is read again from 0 once (its day totals are unchanged;
   test); `INDEX_VERSION` stays 1 and gone entries keep their day buckets, unmigrated. Measured on mdserver1
   2026-11-03, 6,708 live Claude files: 7,117 day buckets become about 52,833 slot buckets (1-min would be 138,540).
3. **Holdings.** For a window, `ledger-store.phaseReplay` returns the open items silent since `since − 7 d` (seed),
   the items open then with later events (carried, started at their first scanned event with the holder their row has
   now, unless a scanned event names a holder or an event after the scan moved the row, `last_seq` above the item's
   last scanned seq: then the holder is unknown until a scanned event names one), and every event of the workspace from `since − 7 d` to
   `until` on the `at` index, in arrival order. The replay folds them with `foldLedgerEvent` (`src/lib/ledger-fold.ts`),
   the same pure fold `project` now calls, so the store and the replay derive one projection. Each state is kept at
   the item's last move (`last_event_at`): a `link` does not move the clock, so a link that arrives before an earlier
   move cannot unsort the item's timeline. History more than 7 days before the window is not read, and every gap it
   leaves resolves to "nothing held" (`other`, `no-held-item`), never to a wrong item (architect property probe:
   164,486 checks, 0 mismatches with full history). Three cases: an item open at the scan start is held only from its
   first scanned event; an item open at the scan start that later closed and reopened is not carried (its row's
   `opened_at` is now inside the scan), so it is invisible until its reopen; an item closed before the scan and
   reopened inside it loses the holder the fold would carry across the reopen, and is held by nobody until an event
   names one. A tab holds an item when
   the item is open and its holder equals the tab's id or its name. Usage is evaluated at its slot's midpoint; of
   several held items the one with the latest event at or before then wins, the lowest key on a tie. Seat items never
   count.
4. **Table.** Wait reason first: review-queue, review-findings → review; rework → build; receipt-rekey and every land
   and deploy reason (land-queue/* included) → land; owner → coordinate; agent-idle, host-load, unknown, or no wait →
   the item type: slice → build; review → review; gate, experiment → evaluate; range, landing, deploy → land;
   owner-issue → plan; mc-item → coordinate. A tab that held no item is `other`, a row, never dropped.
5. **Unattributed, named.** For `phase` and `item`, `unattributedReasons` splits `unattributed` into `no-binding`,
   `no-message-time` (Codex, Grok, pre-slot gone entries), `ledger-unreadable` (ledger.sqlite could not be read; also
   `phaseBasis.ledgerReadable: false` and the error in `index.error`), `no-ledger-history` (a slot midpoint before the horizon =
   max(ledger retention cutoff + 7 d, the workspace's first item's `opened_at`); null with no item, so an empty ledger
   attributes no phase and says so) and `no-held-item` (`item` only). `sum(rows) + unattributed = totals` holds for
   every `by`, and the reasons sum to `unattributed`. `phaseBasis` carries the slot size, the horizon and whether the
   ledger was read. A ledger that cannot be read never fails the spend answer.
6. **Cache reads on every face.** The tile prints "N cache reads (P% of tokens, est. Q% of cost)" beside the total and
   the burndown tokens line "N cache reads (P% of tokens)"; the CLI adds `CACHE-READ-SHARE` and
   `CACHE-READ-COST-SHARE` columns and a "cache reads: N of M tokens (P%); est. Q% of the est. cost" line. A row with
   no tokens has no token share ("—"), never 0%. `ISpendRow` gains `cacheReadCostUsd`: the cache reads' part of
   `costUsd`, null when nothing is priced or a priced Codex or Grok session cost cannot be split (no cost share then).
   `ISpendTokensByDay` gains `cacheReadTokens`.
7. **`cache_read_tokens_per_landed_item`**, for a UTC day and the 7 UTC days ending on it (clipped to the spend floor):
   the workspace's cache-read tokens over the landed ranges in the window. One count serves it and the constraint
   finder: `ledger-store.landedRanges`, a COUNT on the additive table `landings(event_seq PK, workspace_id, item_key,
   at)` indexed on `(workspace_id, at)`. `project` writes a row in the append transaction exactly when the store's
   fold applies a `close` with state `landed` to a `range` (`isLanding`, `src/lib/ledger-fold.ts`), stamped with the
   item's `closed_at`; so a close the projection refuses counts none: a repeat close, a close for an item never opened,
   and a backfill that re-sends the open and close of a range live producers already landed (the open is refused
   because its `at` is not after `closed_at`, and so is its close). A range reopened and landed again counts each
   landing; a close with no state counts none. A ledger that lacks the table gets it on its first open, filled once in
   the same transaction by folding the stored range events with the same fold (`user_version` stays 1, the additive
   pattern of ADR-0035; a backfilled landing time can sit up to a land-queue split later than the live one, since the
   backfill folds range events alone). Measured on the synthetic peak ledger: the one-time fill of 92 days (91,000
   landings) 5.1 s on first open, reopen 1 ms; `landedRanges` over 7 days 0.4-0.5 ms (7,000 landings). The ledger's
   retention job deletes landings older than 92 days with the events. Not measured (value null,
   with the reason) when the ledger cannot be read, holds no item for the workspace yet, the index is not ready, or no
   range landed. Served by `GET /api/cli/spend/phases`. The constraint finder (ADR-0034) reads it through
   `getFinderSpend(workspaceIds, now)`: its one spend read per tick, a by-workspace view of the last 7 UTC days plus,
   per workspace, `landedRanges` and the metric; both `cost-per-landed-item` and the reported
   `cache-read-per-landed-item` anomaly divide by that one count. The ledger part of the finder's tick: the architect
   measured about 0.1 s per tick at the synthetic peak with the earlier events scan (`firstOpenedAt` 43-101 ms warm,
   the 7-day scan 54-59 ms for the loaded workspace, about 21 ms for each other workspace), growing with the number of
   workspaces; with the `landings` count and the `holdsItems` primary-key seek for "holds no item" it is under 1 ms
   per workspace (0.4-0.5 ms and 0.02-0.09 ms). The by-workspace spend view is the tick's other spend cost.
8. **`purplemux spend phases -w WS [--day D]`** (`GET /api/cli/spend/phases`): one UTC day by phase with wall time =
   distinct 5-minute slots in which usage resolved to the row × 5 min (a union per row; rows overlap, so they may sum
   above the total; null for usage with no message time), tokens by kind, est. cost, and the metric for the day and 7 d.

**What proves it wrong.** (1) One live day attributed from raw message times against 5-minute slots: more than 5% of
its Claude tokens change phase → 1-minute slots. (2) After 7 days of live producers, `other` above 30% of attributed
Claude spend in a workspace → holder matching or the table is wrong. (3) Any live entry whose day totals change
across the slot re-read.
