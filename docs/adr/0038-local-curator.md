# ADR-0038: A local curator on the RTX 4090, gated by evaluation

## Status
Accepted (2026-11-03, epic `harness-flow-loop`, story 16; architecture ADR-HFL-06). Routing is per workspace and opt-in
(consult `HFL-consult-v2-open-points.md` point 6). The spot-check item's shape is the story's architect consult of
2026-11-03. The gate's statistical form, the per-version shadow and the set's durability are consult
`reviews/16-promote-gate-consult.md` (review r1 F3-F5). Story 23 adds `reshape-question` and the routing actions (ADR-0042);
this ADR only labels, logs and gates.

## Context
The owner asked for the 4090 to curate harness text and spare Anthropic context. ai-server's Ollama
(`mcp-server-ollama-1`, 0.32.1) listens on `127.0.0.1:11434` only. It serves `gemma4:26b`, which is kodit's chat model,
with `OLLAMA_KEEP_ALIVE=24h`, `OLLAMA_CONTEXT_LENGTH=8192` and `OLLAMA_NUM_PARALLEL=4` (measured 2026-11-03).
`qwen3.5:27b` would evict that model. The library rule is that the model tier is a role and never a saving; the
lever is removing agent loops. Through the tunnel, 10 calls measured 0.1-0.4 s of prompt evaluation and 0.9-15.4 s
of wall time. Almost all of the wall time is queueing behind kodit's enrichment, which runs all day.

## Decision
1. **Serving.** The user unit `purplemux-curator-tunnel.service` on mdserver1
   (`scripts/curator/purplemux-curator-tunnel.service`, installed by `scripts/curator/install-tunnel.sh`) holds
   `ssh -N -L 127.0.0.1:11435:127.0.0.1:11434 ai-lan`:
   - `BatchMode`, `ExitOnForwardFailure` and its own connection (`ControlMaster=no`).
   - `Restart=always` after 10 s with no start limit. A clean exit is also a tunnel down.
   - Its start goes to the journal under its own identifier once the LOCAL listener 127.0.0.1:11435 accepts (the
     line says so; purplemux's `/api/tags` probe checks the far end), and its stop with the result and code.
   - A reinstall (`scripts/curator/install-tunnel.sh`) enables and restarts the unit, so new unit text takes effect.
   - Undo: `systemctl --user disable --now purplemux-curator-tunnel.service && rm -f
     ~/.config/systemd/user/purplemux-curator-tunnel.service && systemctl --user daemon-reload`.
   - The kodit compose is not touched, and no port opens on the tailnet.
2. **Client** (`src/lib/curator-client.ts`, one `globalThis` instance):
   - It sends one request at a time to `POST /api/chat` with a JSON-schema `format` whose label is an enum of the
     offered labels, `think: false` and `temperature: 0`.
   - It sends no `keep_alive` and no `num_ctx`, so a curator call never reloads kodit's model.
   - A call times out after 30 s; the rules then route.
   - An input keeps its last 6,000 tokens, counted at 2.75 characters per token. That is below the measured 3.34,
     so the cut errs short of the 8,192 context. The cut is logged and recorded.
   - The quoted span is kept as returned and checked against the input (`spanFound`).
   - Every finished call is one `tab_events` row: class `log`, kind `curator`. Its text is the JSON record of task,
     model, prompt version, the source id (`<ws>/<historyEntryId>`, `<ws>/<session>/<assistantUuid>` for a Claude
     tab, `<ws>/mc/<itemId>`), outcome, label, the rules' label, span, latency, queue wait, tokens cut and prompt
     tokens. The input text is never recorded, nor the raw reply (an error names what was wrong, never the reply).
     A span is withheld (`span: null`, `withheld: true`) when the input or the span looks like a credential
     (`src/lib/secret-patterns.ts`). A curator row is never counted as a logged event sent to a tab, nor as a
     firing in story 15's effect counts (`recordedCounts`).
   - The kodit gap runs from the end of one call to the start of the next. After a down result (a call or a probe)
     the queue waits 30 s, doubling to 5 min, before it probes again, so a model `/api/tags` lists but `/api/chat`
     refuses never spins.
3. **Tasks** (`src/lib/curator-tasks.ts`). A prompt version is `<base>-<hash>`: an 8-hex FNV-1a of the model, the
   request options, the template rendered on placeholders, its labels and the reply schema, so any edit to the prompt
   or a model change is a new version, with its own clock and evidence. The version key every clock, evidence row,
   queue, evaluation and routing check uses is **H = the prompt hash, the served model digest and (matcher) the
   order-set hash** (`servedVersion`, `<prompt version>~<8 hex>`): a new pull of the tag or an order edit is a new
   version (architect confirm R2). The client probes before any call while health is not `up`, so no call runs
   without a known digest; with the digest unknown, routing reads `shadow` and promote refuses. An evaluation whose
   calls span two H is refused:
   - `classify-owner-message`: an owner message typed in purplemux, into five classes (`standing-order`,
     `product-rule`, `answer`, `status-ping`, `one-off`).
   - `flag-owner-question`: a stop with no end line whose last three lines hold a `?`. Measured on 2026-11-03, 674 of
     38,977 unmarked ws-ldhziO turn endings (1.7%) pass that filter. The rest never ask, the GPU is shared, and
     precision is then measured on exactly what the curator sees.
   - `match-standing-order`: an ending flagged as a question, against the standing orders, giving `SO-n` or
     `not-covered`. Also, in shadow, an `attention.opened` / `attention.updated` whose review needs the owner's
     `approval` or `decision` (once per item; it opens nothing): 314 of the 384 labelled asks are MC items. The
     hook sits in `applyMissionEventBatch`, so a NEEDS-DECISION item the server opens (ADR-0041) is shadowed too. Until
     story 14's store is wired in (story 23), the orders are the seed the set was labelled against
     (`eval/match-standing-order.orders.json`).
   - Each task is `shadow` or `routing`. A task routes only in state `routing`, on the prompt version it was promoted
     on, and in a workspace listed in `curator.routing.workspaces` (admin-only, default empty, so treasury-v2 is not
     in it). In this story no call site routes: every label is logged.
4. **Fallback.** A refused connection marks the tunnel down; a 404 or a tags list without the model marks the model
   down. A call that finds the curator down returns to the head of the queue. While it is down, the queue probes every
   30 s, and a call queued over 10 min drops to the rules. The health probe (`GET /api/tags`, no GPU) runs every
   minute from `server.ts`. The board shows the state: `board show` prints `curator: curator down (<reason>); the rules
   route`, `--line` appends ` · curator down`, and the web board's Curator section shows it in red. `curator.enabled
   off` makes no call at all and reads as down. Shadow calls run only in a started server.
5. **Evaluation gate** (consult `reviews/16-promote-gate-consult.md`).
   - **The sets.** Labelled sets under `~/.purplemux/curator/eval/` hold ids, labels, source times and (owner
     messages) a transcript-twin locator `alt` (`ref`, offsets, `raw` / `collapsed` mode and a 16-hex sha256), never
     text; text is read at evaluation time (`src/lib/curator-sources.ts`): the history entry, else the verified twin.
     One Opus 5.5 pass at high labelled them on 2026-11-03: 592 owner messages (558 with a twin: 532 raw, 26
     collapsed; 34 none), 500 turn endings drawn from the 674 that pass the `?` filter, 384 permission asks (331
     candidates excluded).
   - **Splits.** 30% held out by a hash of the id. `curator eval --split train` runs the complement and keeps its
     rows for prompt work; the held-out run keeps per-class counts only, no per-id prediction, and a whole-set
     (`all`) run keeps the rows of training ids only (its counts cover every item; architect confirm R1).
   - **Durability.** An unreadable item older than 30 days (`CURATOR_SOURCE_HORIZON_MS`: Claude Code's
     `cleanupPeriodDays` default and the `tab_events` retention) has aged out and leaves every denominator. Above 10%
     unresolved inside the horizon, of the split or of any gated class's gold, the evaluation refuses before any
     model call, and promote reads it as no evaluation.
   - **The bound.** A check passes only when its one-sided 95% Clopper-Pearson lower bound reaches the threshold:
     for owner messages 0.90 precision and 0.80 recall on `standing-order` and `product-rule`; the question flag
     0.95 precision; the standing-order match 0.98 precision on `covered` (a covered label counts only when it names
     the gold order). Trials a run needs to pass:

     | Threshold | 0 errors | 1 error | 2 errors | 3 errors |
     |---|---|---|---|---|
     | 0.98 | 149 | 236 | 313 | 386 |
     | 0.95 | 59 | 93 | 124 | 153 |
     | 0.90 | 29 | 46 | 61 | 76 |
     | 0.80 (recall) | 14 | 22 | 30 | 37 |

   - **The pool.** The gate for task T and prompt version H scores the latest held-out evaluation of H plus every
     **labelled shadow row** of H: a live call H made in a real workspace, labelled blind afterwards.
     `curator label-queue --task T` queues the live version's unlabelled calls (ids only; for a precision-only task
     every predicted positive and as many predicted negatives, drawn with a seed and shuffled). `curator
     label-import --task T --file F` (admin) is the only writer: the gold joins `eval/<T>.json`, the prediction
     `eval/<T>.shadow.json`; an id outside the queue is refused. The held-out run leaves out every id with shadow
     evidence of ANY version (a label pass saw it). The labeller reads the texts from `scripts/curator/queue-text.ts
     <T>`, which prints them to stdout and writes no file, so the pass deletes nothing by hand. The curator's own
     spot-check items (`curator-spot-check-*`) are never matched, queued or labelled. Run the pass when the queue
     holds 50 rows or its oldest is 7 days old.
   - **The shadow of the version.** The 72 h clock is `state.tasks[T].shadowSince[H]`, H's first live call; a new
     version starts a new clock. Each gated check also needs 30 labelled shadow rows of H alone with the point
     estimate at or above the threshold.
   - **Spot checks** (one format-2 `multi` item each: `all-right`, `some-wrong`, `cant-judge`; a credential-like
     text is skipped, never redacted; a `system:` actor is never the owner). Owner messages: 30 gold labels drawn
     evenly per class; ids marked wrong leave the gold set, and the held-out evaluation must run after the answer.
     The matcher: up to 30 of the pool's true-positive covered rows, opened only once the pool passes everything
     else; a row marked wrong becomes a false positive. More than 10% wrong among those judged refuses. The number
     map is written only after Mission Control holds the posted item (revision 0); a redraw is refused while it
     stands.
   - A refusal prints each bound rounded down to 4 decimals (`0.9799`, never a rounded-up `0.980`).
   - **Promotion** (`purplemux curator promote --task T`, admin) refuses, naming every unmet condition with its
     measure, until all of the above hold. `curator demote` returns a task to shadow.
   - **Time to pass at today's volume** (moderate; rates measured over 14-26 days, prompt quality unknown):
     `classify-owner-message` about 2-3 weeks (about 47 messages a day, every one labelled); `flag-owner-question`
     about 14 days at 0 errors, 28 at 2 (about 5.5 positives a day); `match-standing-order` about 100-125 days at
     0 errors (about 1.2-1.5 covered asks a day). With today's data no task passes: that is the gate working.
6. **GPU sharing.** The server measures kodit's enrichment rate from `~/stacks/mcp-server/enrich-history.log` over
   ssh `ai-lan`. It compares the 72 h before `liveSince` with the 72 h after, once the after window has passed. A fall
   above 20% sets the client to one call per 10 s (`rateLimitMs`). `curator.min-interval-ms` can only lengthen that
   gap.

## Consequences
The 4090 does a narrow, auditable job and nothing waits on it. Latency is dominated by kodit's queue, which is why the
calls are serial and timed out, and why the flag task is pre-filtered. Three limits make the sets a rolling window:
`message-history.json` keeps 500 entries a workspace (ws-ldhziO's labelled ids are gone in about 13.5 days), Claude Code
deletes a transcript 30 days after its last activity, and `tab_events` keeps 30 days. Twins carry owner messages past
the first; the 30-day horizon ages items out of the second and third, and the label pass refills the set. Evidence for
a fixed version does not decay: a labelled shadow row keeps its prediction and gold and needs no text.

## What proves it wrong
- The gate fails on two prompt revisions.
- In production, more than 2% of routed labels are corrected within a week.
- kodit enrichment falls by more than 20% even after rate-limiting.

In any of these cases, the task goes back to shadow (`curator demote`) and the rules stay.

## Rollback
Remove the tunnel unit (the undo command above). The client then reads down and the rules route. A server
rolled back to a build without the client ignores `~/.purplemux/curator/` and the `curator` rows in `tab_events`.
