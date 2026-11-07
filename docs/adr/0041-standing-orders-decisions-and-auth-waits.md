# ADR-0041: Standing orders, NEEDS-DECISION into Mission Control, and auth waits

## Status
Accepted (2026-11-03, epic `harness-flow-loop`, story 14; architecture ADR-HFL-05 decisions 4-6). Extends ADR-0015
(a fourth watch kind, `auth`), ADR-0035 (the wake kind `standing-order`, urgent) and ADR-0037 (a server producer of
format-2 questions).
Amended 2026-11-04 (defect D7, §1 Authority: the portfolio manager proposes a fleet order and the owner confirms it):
see the amendment at the end. Its code landed in epic `harness-flow-loop-2`, story 02 (`src/lib/so-proposal.ts`,
`src/lib/so-proposal-service.ts`, `POST /api/cli/standing-orders/proposals`, `purplemux so propose`).

## Context
The owner's 572 messages of 20 Oct-3 Nov (harness audit, 2026-11-03) repeat the same rules: access already given 14,
act without asking 13 plus 7 grants, questions to Mission Control 12, consult v1 16, "surely we have the data" 10. A
rule said in chat lives in one seat's context until its next compaction; no other tab sees it. 19 messages were
manual-step reports (awslogin, VPN, merge) relayed to the tabs that waited on them. A question an agent ends its turn
on reaches the orchestrator as a nudge, and the owner only when a seat copies it into Mission Control.

## Decision

### 1. Standing orders
- Files: `~/.purplemux/standing-orders.md` (fleet) and `~/.purplemux/workspaces/<ws>/standing-orders.md`, 0600, written
  tmp + rename (a tmp name per writer) under one host lock. A file must start with its `# Standing orders:` header: an
  empty or header-less file is refused, never read as zero orders. Each `## SO-<n>` block has `text` (one line, at most 600 characters), `source` (the
  owner message id and its UTC date), `scope` (default the file's owner), `check` (a hook or test name, or `prose`),
  `state` (`active` or `struck`), `added`, and `struck: <UTC> — <reason>` once struck. Ids are unique across every file
  and never reused, so `SO-<n>` names one order wherever a handoff or a ruling cites it: `standing-orders-seq.json` keeps
  the highest id ever handed out, so an id survives the removal of the workspace directory that held it.
- Budget: the active fleet orders plus the active orders of one workspace, as rendered into its prompt, are at most
  8,192 bytes. An add that would pass it for any workspace it reaches is refused (`so-too-large`, exit 2) with the
  measured size and the workspace. The measure is the rendered section, not the files: struck orders stay in the files
  as history and cost no prompt.
- Authority: a fleet order is added or struck with the admin token; a workspace order by that workspace's tabs or the
  admin token. Every order carries a source, so an order names the owner message it came from. (Amended 2026-11-04:
  the owner's Yes on a proposal of the selected portfolio manager also adds a fleet order. See the D7 amendment.)
- Delivery: the active orders are written into the workspace's `claude-prompt.md` (the `--append-system-prompt-file`
  every Claude tab loads) at server start, on every Claude launch (a local tab through `buildClaudeFlags` at create,
  restart and resume; a remote tab through `createRemoteSession`, which writes the file and ships it in the kit at every
  remote session create, and a remote restart reaps the session and creates it again), and when an order changes. The
  prompt file is written tmp + rename; a write that fails is logged and the launch goes on with the last file written. A change also sends each live agent tab it reaches
  one line through the tab event router, wake kind `standing-order`, class `urgent`:
  `[purplemux standing order] SO-<n> added|struck (<owner>): <text> — …`. A running session does not reload its prompt
  file, so the line carries the order's text.
- Seed: a missing fleet file is created with SO-1..SO-7, the W8 orders of ADR-HFL-05 decision 4, each sourced to the
  owner message the audit quoted for its cluster (`src/lib/standing-orders-seed.ts`). An existing file is never
  re-seeded. The seed is written under the host lock: the first start reads the fleet file once per workspace, all at
  once. A file in another layout is refused (`so-unreadable`), never read as empty; the prompt then says the orders
  could not be read. Seed SO-7 runs `purplemux board show --line`, which takes the tab's workspace from
  `PMUX_WORKSPACE_ID` when `-w` is absent; a test runs every command a seed order names through the CLI parser.
- Striking an order already struck is refused by state: `so-struck`, exit 3.
- CLI: `purplemux so add (-w WS | --fleet) --text T --source S [--scope S] [--check C]`, `so strike SO-N --reason R`,
  `so list [-w WS] [--all] [--json]`. Routes: `GET|POST /api/cli/standing-orders`,
  `POST /api/cli/standing-orders/<SO-n>/strike`.

### 2. NEEDS-DECISION opens a Mission Control item
- A classified stop whose last line starts `NEEDS-DECISION:` opens one item, whatever the tab's `reportOn`, unless an
  item for the same line is still open (candidate or open), whoever opened it: the worker repeating its line while it
  waits, or the orchestrator that opened the item from the note below; or the tab opened an item since its previous stop
  (the turn's start; `mission_item_openers.opened_at`). The item id is
  `nd-<16 hex of workspace, tab and the whitespace-normalized line><16 hex of the stop's time and seq>`: the first half
  names the question, and the store finds an open item by that id prefix (`openItemsWithIdPrefix`), from any opener;
  the second half takes the stop's time as well as its seq, which restarts at 0 with the server. What a line does once its
  item is answered or resolved is the PM-2 amendment below: for 24 h after the answer it opens nothing. After a cancel,
  the same line opens a new item.
- The opener never throws: a failing dependency (an SQLite read, the workspace read, the module load) is the outcome
  `error`. Every outcome that opens no item (`no-orchestrator`, `no-orchestrator-run`, `refused`, `error`) carries the
  id the server would have used.
- The item opens before the orchestrator's nudge, and the nudge's end line carries one note:
  `[MC item <id> opened for the owner by the server: do not open another]`,
  `[MC item <id> already open for the owner: do not open another]`,
  `[MC item <id> opened by the tab this turn: handle it as any worker item]`, or a fallback note below. The
  orchestrator contract names each note and what it asks; it says never to copy such a question into Mission Control.
- The question is built from the whole last line of the turn's tail, not the marker line clipped at 300 characters for
  the nudge. The tail is the end of the message, so a line that starts inside it is whole; a line that runs from the
  first character of a tail cut at 600 characters may lack its start, and is then an `answerType: text` question whose
  context says the line was clipped.
- The line: an optional `[money|irreversible|scope|bookkeeping]` tag gives the class (none: unclassified); `(a) … (b) …`
  or `(1) … (2) …`, two to four in order, give the options of an `answerType: single` question. With no options, or
  an option label over 60 characters, the question is `answerType: text` and the options stay in the context
  verbatim. `decision` is the question clipped at a word to 120 characters; the context quotes the whole line.
- The item is format 2 (ADR-0037) and opens human-visible in one `attention.opened` event that carries the human
  review (`humanNeed: decision`) of the workspace's configured orchestrator, on that orchestrator's open run. The
  event goes through the events route's own batch function (`applyMissionEventBatch`): the same validator at the fleet
  minimum version, the server-resolved orchestrator identity, the store's review authority check, and the owner's
  attention-opened push (title "Mission Control: answer needed"; a tap opens the item), which a server-opened item
  sends like any other. The opener is the tab (`identity: hook`). Event ids `system:needs-decision:*` are reserved: no
  request may use them.
- Fallback when no item opens. Questions are answered in Mission Control; a push is a last resort.
  (i) An orchestrator can receive it: the reason is `no-orchestrator-run`, `refused` or `error`; the workspace has a
  configured orchestrator that is not the asking tab; the tab's escalation target is that orchestrator; and the
  orchestrator is a live agent tab (not retired, not inactive). Then the server sends no owner push, the nudge goes to
  the orchestrator even when the worker's `reportOn` withholds `NEEDS-DECISION`, and the note is
  `[no MC item (<reason>): open it yourself: resume or start your Mission Control run, then open item <id> from this line with your human review. The owner has not been told.]`.
  The id-prefix dedupe then turns the worker's repeat into `already-open`.
  (ii) No orchestrator can receive it (`no-orchestrator`, the asker is the orchestrator, or (i) fails): one push of
  alert kind `needs-decision`, title `Decision needed: no Mission Control item`, body
  `<tab name or id> · <workspace name or id>: <the line without the marker and the class tag, whitespace collapsed>`
  cut at 400 code points at a word, with a trailing `…` (story 36; 100 code points before it, with no mark, cut the
  options mid-word); it carries the tab and workspace, so a tap opens the tab. One push per workspace, tab and
  normalized line in 24 h, kept in memory (at most 2,000 keys, oldest evicted; a restart may send one more push). The
  dispatch is never awaited. The note says what the server did, never what the owner received:
  `[no MC item (<reason>): owner push dispatched, delivery not confirmed]`, or
  `[no MC item (<reason>): owner push for this line already dispatched at <UTC ISO time>]`. Not the inbox: an inbox
  line carries no caller text (ADR-0012) and addresses a tab. Seed SO-6 says exactly this.

- **Amendment (story 36, 2026-11-04; review r1): the asking tab hears what became of its line.** The note above rides
  only the nudge to the tab's escalation target, so a tab with none — the orchestrator itself, or a tab in a workspace
  with no orchestrator and no `reportsTo` — never learned that its line opened no item (D1: an orchestrator with no run
  ended on its line four times; the owner push went out each time, and the asker heard nothing).
  - **One id per line key for 24 h.** The server remembers the first id it mints for a line key (workspace, tab and the
    normalized line) and gives that id to every stop of the line for 24 h from then, unless an item of that id has
    closed (answered, resolved, cancelled), when the line takes the stop's own id. (The PM-2 amendment below decides
    first whether such a line opens anything.) So "its id would be <id>"
    is true: a later server open, or the orchestrator's open from the (i) note, takes that id, and a second open meets
    the same id (`already-open`). In memory, at most 2,000 keys; after a restart the store gives the id back (story 03
    amendment of epic `harness-flow-loop-2`, below). The id shape above is unchanged; only its second half is now the
    first stop's.
  - **The line key ignores a quoted id.** `nd-<32 hex>`, bare or in `()`/`[]`, is removed before the line is
    normalized, so an asker that quotes its item id in the repeat keeps the key and finds the same item.
  - **The notice.** After the stop is recorded, the asking tab gets one urgent event of wake kind `mission`. For every
    outcome that opens no item (`no-orchestrator`, `no-orchestrator-run`, `refused`, `error`), whoever else is told:
    `[needs-decision] item-not-opened: <reason>[ (<detail>, one line, at most 200 chars)]. Your NEEDS-DECISION line
    opened no Mission Control item; <fate>. Its id would be <id>.` The fate is what the server did: for (i), `your
    orchestrator <tab> was told to open it and holds the line now: do not repeat the line`; for (ii), the push text. An
    asker that is the configured orchestrator also reads `You are the orchestrator: resume or start your Mission Control
    run, then open item <id> from your line with your human review.` When an item opened or is already open and the
    nudge that carries the note does not go out — no escalation target, or the tab's `reportOn` holds the marker back —
    it gets `[needs-decision] [MC item <id> opened for the owner by the server: do not open another] …` (or `already
    open for the owner`), so it can name the item. When that nudge goes out, the target holds the note and the asker is
    told nothing itself.
  - **Once a day per line, notice and id.** Keyed by line key, notice kind (not opened / item) and id, 24 h, in memory
    like the push (at most 2,000 keys; a restart may send one more notice). The line the tab repeats while it waits never wakes
    it in a loop, while the open that follows a not-opened stop is still told; a repeat after the open sends nothing new.
  - **The (ii) push is unchanged, and it means "no item opened".** It goes out only when no item opened, so it never
    carries an `itemId`, and the phone opens the tab for it (an `nd-` id on a `needs-decision` alert would open that
    item; the server sends none). Its body is `needsDecisionPushDetail` (`needs-decision.ts`), exported so the phone's
    fixtures are built by the server's own function.

- **Amendment (story 09 of epic `harness-flow-loop-2`, 2026-11-05; defect D28): who may open an owner item.** v2-scope, a
  tab with a `reportsTo`, ended on a line that only quoted the marker, the server opened an owner item from it, and the
  owner asked "why am I getting this?".
  - **A tab with a `reportsTo` asks that tab, never the owner (SO-6).** Its `NEEDS-DECISION:` line opens no item and
    sends no owner push. The nudge goes, whatever its `reportOn`, to its `reportsTo` while that is a live agent tab not
    halted by a usage limit, else to a live, un-halted orchestrator, with the note `[no owner item: this tab reports to
    <tab>, so its NEEDS-DECISION is answered by you[, the orchestrator (<tab> cannot take it)], never sent to the owner
    (SO-6); answer it, or ask the owner on your own end line]`.
  - **A question never vanishes (review r1).** When neither can take it (the `reportsTo` is gone or halted, and no live
    orchestrator exists), the line takes today's path: the owner item opens (or the (i)/(ii) fallback runs), and the
    item's context and human reason state `reports-to target unavailable: <tab> is gone or halted, and no live
    orchestrator can take it`. Only then does a `reportsTo` tab's question reach the owner.
  - **No question, no item.** The opener refuses a line whose text after `NEEDS-DECISION:` holds no `?` (or `？`):
    outcome `no-question`, logged with the line. There is no owner push and no "open it yourself" note; the nudge note
    is `[no MC item: the NEEDS-DECISION line holds no question mark, so the server opened nothing and told no one]`, and
    an asker that the note does not reach gets `[needs-decision] item-not-opened: no-question. …`.
  - A line that holds two markers is no end line at all (ADR-0018, story 09 amendment), so it never reaches the opener.

- **Amendment (story 03 of epic `harness-flow-loop-2`, 2026-11-05; NomuPay/engineering#521, ruling R-03): one open item
  per line, after a restart too.** The id memory above is in memory only. After a restart a miss minted a fresh id, so
  the orchestrator could act on an (i) note from before the restart and open the old id while the server opened the
  new one: two items for one question. The word `already-open` was true only of the server's own check.
  - **The store answers a miss.** When the memory holds no open id for the line key (a restart, the 24 h window, or a
    closed item), the opener reads the store's still-open items with the prefix `nd-<lineKey>` (`openItemsWithIdPrefix`)
    and takes the newest; with none, the stop's own id. The opener remembers the id it takes. A failing read counts as
    no open item. The opener's own dedupe also names the newest open item.
  - **The store refuses a second open item for one line.** An `attention.opened` whose item id starts with
    `nd-<16 hex>` is refused while another item of that prefix in the same workspace is candidate or open, from any
    opener (server, orchestrator or worker). The response is HTTP 409 with the body
    `{"error": "an item for this NEEDS-DECISION line is already open: <open item id>", "code": "already-open", "current": <the open item>}`.
    The same id again stays the 409 `conflict` `attention item already exists`. Once the open item is answered,
    resolved or cancelled, the store accepts an `nd-` id of that line again; the server opener does not use it while the
    PM-2 amendment below holds.
  - **A racing open is `already-open`, not `refused` (review r1).** If another opener takes the line between the
    opener's dedupe and its own write, the opener reads the typed refusal: the outcome is `already-open` with the open
    item's id (`current.id`), and the line keeps that id. So no "open it yourself" note and no (ii) push go out for an
    item that is open. Every other refusal stays `refused`.
  - **The asker hears a note that the repeat filter held back.** A tab already `ready-for-review` that ends on the same
    marker again sends no second nudge. The note of that stop then reaches no tab, so the asker gets it itself (the
    notice above): "the note rides the nudge" means the nudge that survives the repeat filter.

- **Amendment (story PM-2 of epic `harness-flow-loop-2`, 2026-11-07; defects D50 and D51): one item per question.** SO-6
  says "repeat the same line without changes", but an agent does not always obey it. Measured on the live store
  (2026-11-07): a reworded line opened a second item 38 s after the first (D50, ws-o9gb_Q); the exact line opened a
  second item 22.2 min after the owner's answer, and after the ack (D51, the Portfolio SM). The server now copes.
  - **How a line is recognised.** The line key is unchanged, except that the `[new]` marker is removed before the key is
    made, so `[new] Q` and `Q` have one key. A side table, `mission_nd_lines` (item, line key, workspace, tab, revision,
    `[new]` flag, text key), records each line key an `nd-` item took. The store writes the row in the event's own transaction,
    from a batch side input that only the server opener's `system:needs-decision:` events carry; it refuses a row on an
    item that is not `nd-` or that another tab owns. Revision 0 rows record a key outside an event: the id the server
    handed to the orchestrator (it counts once that item exists), and a line that met its item in a race. The tab's
    items are its line rows, its own `nd-` openers (items from before this table) and any item with the prefix
    `nd-<lineKey>`. A restart loses nothing.
  - **The states.** OPEN is `candidate` or `open`. An item is ANSWERED from the answer until the end of the answer
    window: **24 h from the answer's time** (`NEEDS_DECISION_ANSWER_WINDOW_MS`), in state `answered` or `resolved`.
    "Acked" is the answer's delivery row in state `acknowledged`. A cancelled item never matches.
  - **The decision table.** The first row that holds wins:
    1. An OPEN item of the tab took this key at any time: `already-open`. No write, so a line that goes A, B, A does not
       revise the item again.
    2. An ANSWERED item took this key, or this text key: outcome `answered`, and the line does not differ. This is true
       before and after the ack, and with `[new]` too, because an asker repeats a `[new]` line while it waits. The text
       key (round 2, review r1 finding 2) is the question text without the marker, `[new]`, the class tag and quoted ids,
       whitespace collapsed and letter case folded; the options stay. So `[scope] Q?` after `[money] Q?` was answered
       is the same question. Row 1 stays exact, so a tag change while the item is open revises it (row 5) and the new
       class reaches the owner. Rows written before the `text_key` column have none and match by line key only.
    3. The tab itself opened an item since the turn began (`asked-this-turn`). The server's own `nd-` item of the
       previous stop does not count.
    4. **One `[new]` question per tab at a time; a `[new]` line never revises** (round 2, ruling A, which replaces
       consult change 3). The tab's waiting `[new]` question is its newest item opened by a `[new]` line (the
       revision-1 row, else the revision-0 reservation of an id handed to the orchestrator) that is OPEN, or ANSWERED
       with an answer that is not acknowledged. A `[new]` line opens (row 5) only when there is none. Otherwise the line
       is held: it opens nothing and writes nothing. If the waiting question is OPEN, the outcome is `already-open` for
       it with `heldNew`. If it is ANSWERED, the outcome is `answered` for it with `heldNew`. The hold lifts when that
       answer is acknowledged, when the item is resolved or cancelled, or when the answer passes the window; an OPEN
       waiting question has no time limit. Why one, not N: SO-6 tells the asker to repeat its line while it waits, so
       a reworded repeat of a `[new]` line has a new key. With N waiting `[new]` questions allowed, each reworded
       repeat opens another item, which is D50 again through the marker (N = 3 gives the three items of R140). The cost
       is two questions from one tab at once; in the record, all 9 follow-up questions came after the ack. A held line
       is a question outside Mission Control, so its nudge goes out whatever the tab's `reportOn` (`mustReach`), and
       the asker hears its notice too.
    5. The line has no `[new]`. Then:
       - If the tab has exactly one OPEN item and its state is `open`, the server revises it. It sends `attention.updated`
         on the item's own run, with the orchestrator's review again and the new question; the revision goes up by
         one. The event id is `system:needs-decision:<32 hex>:r<revision>`. The outcome is `revised`.
       - If the tab has more OPEN items, or a candidate, the outcome is `already-open` for the newest. Nothing is
         written, and the notice lists the open ids.
       - If the tab has an ANSWERED item whose delivery is not acknowledged, the outcome is `answered`, and the line
         differs from the question.
    6. Otherwise the line opens an item by the path above.
  - **What opens a new item.** Only row 6, or row 4 with no waiting `[new]` question: a `[new]` line that matches no
    OPEN item and no ANSWERED item, while the tab has no waiting `[new]` question; a line without the marker when the
    tab has no OPEN item and no unacknowledged ANSWERED item; any line after the answer window or after a cancel.
  - **A failed revise opens nothing.** The item's state after the failure decides. If it is still OPEN, the outcome is
    `already-open`. If it was answered in the race, the outcome is `answered`, and the line key is recorded on the item.
    If it was cancelled, the line opens anew. A failed revise is never `refused`, because that would send an "open it
    yourself" note and an owner push for an item the owner can already see.
  - **The answer goes to the asker again.** No delivery is queued again: the delivery goes to the run binding (the
    orchestrator), and a held row can be a paste that happened. The asking tab gets one urgent `mission` event:
    `[needs-decision] [MC item <id> answered by the owner at <UTC ISO>: do not open another] The answer: (<id>) <label>;
    "<text, at most 200 chars>". <delivery>. <next>`. The delivery part is "It went to <tab> (delivery <state>), which
    relays it", or "It was delivered to you" for an orchestrator, or "Delivery held: <reason>". A clipped answer says
    so. A line that differs also quotes the answered question. For the same question (round 2, finding 4), `<next>` is
    `Act on this answer: this question opens no new item until <UTC ISO of the answer + 24 h>, with or without [new].`
    and then the `[new]` sentence below, or, with no waiting `[new]` question, `If something has changed since the
    answer, ask a new question that says what changed: end on NEEDS-DECISION: [new] <question>?`. For a line that
    differs, `<next>` is the `[new]` sentence. The nudge note is `[MC item <id> already answered by the owner: no new
    item; relay the answer]` (or `…; delivery held: <reason>`).
  - **The `[new]` sentence (round 2).** One helper builds it for every notice that offers the marker (already-open with
    the open ids, revised, answered), from the same waiting `[new]` question the table reads, so no notice offers
    `[new]` while the table would hold it. With none: `A different question: end on NEEDS-DECISION: [new] <question>?`.
    With an OPEN one, P: `A different question cannot open yet: this tab's [new] question <P> is still open, and a tab
    has one [new] question at a time. End on your [new] line again after <P> is answered and its answer
    acknowledged.` With an ANSWERED one: `… the owner answered this tab's [new] question <P>, and the answer is not yet
    acknowledged. End on your [new] line again once it is (your orchestrator acknowledges it when it relays it).` No
    notice tells the asker to cancel an item: a cancel is an event on the item's run, which the asker does not hold.
  - **The held notices (round 2).** P open: the note is `[MC item <P> already open for the owner: do not open another;
    this [new] line is held and is not in Mission Control: the tab's [new] question <P> is still open]`; the asker
    hears `[needs-decision] [MC item <P> already open for the owner: do not open another] Your [new] line opened
    nothing and changed nothing. This tab's [new] question <P> is still open ("<P's decision>"), and a tab has one
    [new] question at a time. If your line rewords that question, end on that item's line unchanged. If it is a
    different question, it is not in Mission Control yet: end on it again with [new] after <P> is answered and its
    answer acknowledged.` P answered and unacknowledged: the note is `[MC item <P> already answered by the owner: no
    new item; this [new] line is held until that answer is acknowledged; <relay the answer | delivery held: …>]`; the
    asker hears the answered notice, which says `Your [new] line opened nothing: the owner answered this tab's [new]
    question "<question>", and its answer is not yet acknowledged.` before the answer, and ends on the `[new]`
    sentence.
  - **The revise notice.** The note is `[MC item <id> revised for the owner by the server (revision <n>): do not open
    another]`. The asker always gets it, even when the nudge goes out, because only the asker can add `[new]`. It says:
    `… Your line replaced the question "<old decision>"; the owner no longer sees it. If yours is a different question,
    ask the replaced one again in its own item: end on NEEDS-DECISION: [new] <the replaced question, in new words>?
    (its old line stays item <X>'s).` With a waiting `[new]` question, the last sentence is the `[new]` sentence. It
    names the replaced question, not the new line (round 2): the revise recorded the new line's key on the item, and
    the replaced line's key is the item's too (row 1, and the store's prefix refusal), so `[new]` with either line
    finds the item again. The notice key holds the notice kind, so an earlier `opened` notice of the same id does not
    mute it.
  - **The owner's answer and a revision.** An answer typed against the old revision gets a 409 only when the revision
    is incompatible (the decision, the answer type, or a removed option). A changed label or context keeps the answer
    (ADR-0037 §4).
  - **Known gap.** The ack comes from the orchestrator, not from the asker. So after the ack, a reworded repeat of an
    answered question opens a new item. The AC permits this; the asker notice and SO-6 tell the asker not to do it.
  - **Other producers do not change.** A tool's `attention.opened`, the improvement seat, and the Scrum Master's items do
    not carry the side input. The store's prefix refusal (#521) is unchanged.
  - **SO-6.** The seed text now says: "While you wait, repeat the same line without changes; a reworded line revises
    your open item. A different question opens its own item only with the marker: NEEDS-DECISION: [new] <question>."
    The seed is written only to an absent fleet file. The live SO-6 changes only by an owner amendment.

### 3. Auth waits
- Watch kind `auth`, target `aws-sso:<profile>`, until `signed-in`, interval 60 s by default; CLI
  `purplemux wait add --auth PROFILE [--item LEDGER_ITEM_KEY]`. It runs in the local lane with lease watches.
- Proof: the AWS CLI's own token cache file. `~/.aws/config` names the profile's `sso_session` (cache file
  `~/.aws/sso/cache/<sha1 of the session name>.json`) or a legacy `sso_start_url` (`sha1` of the URL). The token is
  valid when the file has an `accessToken` and an `expiresAt` at least 5 minutes ahead; a client registration file has
  no `accessToken` and proves nothing.
- It fires on a sign-in, a change: the baseline is the token valid at creation (`sso:<expiresAt>`, or none). A watch
  raised on a missing, expired or nearly expired token fires on the first valid one; a watch raised while a token is
  valid fires only when a different valid token appears (the owner signed in again), never at once.
- The cache read is this server host's `~/.aws`: an auth wait from a remote tab is refused (`watch-invalid`) with a
  message naming both hosts. The check fails closed: when the layout cannot be read or does not hold the calling tab,
  the wait is refused (`caller-unresolved`, exit 3) and never taken for a local tab. A profile that is not SSO is refused at creation (`watch-invalid`). An unreadable
  config or cache file is the failing token `sso-config`.
- No process is started and no AWS endpoint is called: DEC-261 forbids an agent run through the owner's SSO unless the
  owner asks. A test records every `child_process` entry point while a watch is created, read and fired.
- When it fires: one inbox line (`… aws-sso:<profile> is signed in: its SSO token is valid until <UTC>; retry the step
  that needed it — watch cleared`), then a ledger `clear` event from the server producer for the open `deploy-auth`
  wait of `--item`, and of every item of the workspace whose clear input names the profile as a word.

## Consequences
- A rule said once reaches every Claude tab at its next launch and every live tab at once; a strike does the same.
- An agent's question reaches the owner's Mission Control (web and the phone, APK 1.0.3) in the turn it is asked.
- The owner's `awslogin` is the signal; nobody relays "done".
- A remote tab loads the orders active at its create. A remote restart reaps the session and creates it again
  (`restartTabSessionUnguarded` -> `createSession` -> `createRemoteSession`), so it loads the orders active at the
  restart. The kit's copy goes stale only between launches: no path launches Claude on a remote host without a create
  first (auto-resume skips remote tabs; the launch-command route refuses them).
- The orchestrator receives the answer to a NEEDS-DECISION item, because it owns the run; it relays it to the tab.
- The nudge goes to the tab's escalation target; the item and its answer belong to the configured orchestrator.

## What proves it wrong
Owner repeats of the top clusters stay above 1 a week each after 14 days, or the owner still relays manual steps more
than once a week. Then the orders are not reaching the tabs, or the tabs do not read them: measure the prompt files
and the delivered `standing-order` events before adding mechanism.

## Amendment (2026-11-04, epic `harness-flow-loop`, defect D7: the SM proposes a fleet order, the owner confirms it)

§1 "Authority" gains a second way to add a fleet order. The admin-token way stays as it is.

**Status.** Accepted (2026-11-04). Owner decision: Mission Control answer `8638e767-af5f-4452-8ec1-6e89dee0ab45`
(2026-11-04T02:15:17Z, option `followon`). The answer moved the D7 code to a follow-on epic and asked for this ADR
now. Sources: the triage `_output/harness-flow-loop/briefs/D1-D8-triage.md`, row D7, and the Portfolio SM's defect note
`n-sqL9hVZwJY`, D7.

**Deferred to the follow-on harness epic:** all the code and all the tests below (triage estimate: about 150 agent
minutes). Until that epic lands, §1 applies unchanged, and the interim workaround below is in force. (Landed:
`harness-flow-loop-2` story 02. The tests are `tests/unit/lib/so-proposal.test.ts`, `so-proposal-authority.test.ts`,
`tests/unit/api/so-proposal-answer-route.test.ts`, the `so propose` case of `tests/unit/bin/cli-so-wait.test.ts` and the
proposal cases of `tests/unit/components/mission-question-card.test.tsx`. The interim workaround ends when the library
text changes, story 39.)

**Context.** The Portfolio SM (`tab-9gEerd` in `ws-zOfVyu`) ran `so add --fleet` to record an owner rule for every
seat. The server refused it: "a fleet order is added or struck with the admin token" (`mayChangeOrders`,
`src/lib/standing-orders-service.ts:28-31`; pinned by `tests/unit/lib/standing-orders.test.ts:227` and
`tests/unit/bin/cli-so-wait.test.ts:120`). The owner's channel rule then went out as 3 notes. A rotated seat can lose
a note, but a standing order reaches the prompt of every Claude tab (§1 Delivery). The note asks for a fleet order by
the SM, or else for a way to ask the owner for one tap.

**Options considered.**
1. **A fleet grant for the SM.** The human-selected portfolio manager adds a fleet order that cites an owner message,
   with an audit row. Rejected:
   - An agent-written fleet order reaches the system prompt of every Claude tab on the host (`claude-prompt.md`, which
     each tab loads with `--append-system-prompt-file`). That includes the workspaces outside the SM's selection.
   - The cited message is the agent's word. The server cannot check that the owner said it, or that the text says what
     the owner meant. Today the SM cannot list the ids of the owner's chat messages, and a message sent again gets a
     new id (defect D8).
   - A misread rule would steer the whole fleet until the admin token strikes it.
   - ADR-0021 confines agent mutations to the caller workspace. The fleet file belongs to every workspace.
2. **A server item of class `bookkeeping`.** Rejected: it would let the auto-answer file the order. Bookkeeping is the
   one class that the ADR-0031 rule answers. With a stated default of Yes, the rule would file a fleet order N minutes
   after the item opened, with no owner. With no default, the board would still put the item in the Bookkeeping group,
   which tells the owner that a rule may answer it. A fleet order changes the prompt of every tab: that is scope. (The
   curator's keep-or-strike item is bookkeeping because its default, keep, changes nothing: ADR-0042 §2.)
3. **The SM proposes; the server opens a `confirm` item of class `scope` with no default; the owner's Yes files the
   order.** Chosen. The owner taps once, and the owner's answer is the authority for the order.

**Decision.** Option 3.

1. **Who proposes.** Only the human-selected portfolio manager. `selectedScrumMasterScope`
   (`src/lib/scrum-master-access.ts`) must return the selection for the caller. So the caller is a launch-verified
   tab, the saved selection names its workspace and tab, and the tab is the enabled orchestrator of its own workspace,
   with a live session. The server refuses every other caller with `forbidden` (exit 3): another tab, a hook-identity
   tab, the SM after the selection moved, and the admin token (which adds the order with `so add --fleet`).
2. **The command.** `purplemux so propose --text T --why W [--cites C] [--scope S] [--check C]`, on the route
   `POST /api/cli/standing-orders/proposals`. A proposal is always for the fleet file.
   - `--text`, `--scope` and `--check` are the order fields of §1, with their limits.
   - `--why` is one line of at most 200 characters. It becomes the item's `whyNow`.
   - `--cites` is optional, at most 300 characters: the owner message that the SM relays (its id when it has one,
     else the chat and its UTC time). It goes into the item's context and the audit row, never into the order's source.
3. **Checks before the item opens.** If a check fails, no item opens and nothing is filed.
   - A field is not valid: `so-invalid` (exit 2). The message names the field.
   - The order would take a workspace past the 8,192-byte budget: `so-too-large` (exit 2), with the measured size.
   - An active fleet order has the same normalised text (`normalisedOrderText`, ADR-0042 §2): `so-proposal-refused`,
     reason `duplicate`. The message names that SO-k.
   - An open proposal has the same normalised text: `so-proposal-refused`, reason `open-proposal`. The message names
     its item.
   - The SM's workspace has no open run bound to its orchestrator: `so-proposal-refused`, reason
     `no-orchestrator-run`. The message tells the SM to start or resume its Mission Control run, then propose again.
   - `so-proposal-refused` is a new code, exit 3 (refused by state). The follow-on epic adds its row to the ADR-0016
     table and the api-guide exit table.
4. **The item.** The server opens one item on the orchestrator's bound run of the SM's workspace. It goes through
   `applyMissionEventBatch`, as the NEEDS-DECISION item does (§2): the same validator, the review stamp, and the
   owner's attention-opened push.
   - Id: `so-proposal-<16 hex of the normalised text><8 hex of the open time>`. The server finds an open proposal for
     the same text by the id prefix (`openItemsWithIdPrefix`).
   - Format 2, `kind: question`, `answerType: confirm`, options `yes` and `no`, with no option recommended.
     **Class `scope`, and no `defaultOptionId`.**
   - `decision`: "Add this fleet standing order? It reaches every Claude tab on this host." `whyNow`: the `--why` text.
   - `context` quotes the order text verbatim in a code block. It also states the scope, the check, the proposer
     (`<workspace>/<tab>`), the `--cites` text, the count of workspaces and live Claude tabs that the order reaches,
     and the largest prompt section that the add makes, beside 8,192 bytes. Its last line: "Yes files the order
     exactly as quoted. No, text alone, or no answer in 72 h files nothing."
   - `humanReview`: `humanNeed: decision`, with the SM as the reviewer.
   - The item has no opener row. So a `NEEDS-DECISION:` line of the SM in the same turn still opens its own item (§2).
   - The event-id prefix `system:so-proposal:` and the item-id prefix `so-proposal-` are reserved, as
     `system:curator-so:` and `curator-so-` are (ADR-0042 §2). No tab or token can open or revise such an item, so no
     producer can change its class or add a default.
   - The record: `mission_so_proposals(item_id PRIMARY KEY, workspace_id, proposer_tab_id, text, scope, check_name,
     cites, state, answer_id, order_id, reason, created_at, decided_at)` in the Mission Control database. It is
     unversioned, created with `CREATE TABLE IF NOT EXISTS`, and written in the item's transaction, as
     `mission_item_openers` is. The filed order takes its text from this record, and the context quotes the same
     input. `state` is `open`, `filed`, `declined`, `expired`, `withdrawn` or `not-filed`.
5. **The ADR-0031 auto-answer can never file it.** Each of three facts stops it:
   - eligibility requires class `bookkeeping` (ADR-0031 §5);
   - eligibility requires a `defaultOptionId`;
   - the reserved prefix stops every revision of the class and the default.

   The answer step below also ignores an answer whose actor starts with `system:`.
6. **The answer step.** The human answer route (`src/pages/api/mission-control/items/[itemId]/answers.ts`) runs the
   step after it stores the answer, never inside that transaction, beside the curator's step. A 60 s pass in the
   ADR-0031 §6 tick runs the same step for every record in state `open`, whatever the auto-answer key holds. So a
   restart or a crash after the answer cannot lose a Yes.
   - **Yes** (`optionIds` is `['yes']`, from a human actor): the server adds the order to the fleet file as the
     server's admin caller, the caller that the curator uses for a strike (ADR-0042 §2). The text, scope and check
     come from the record. The source is
     `owner answer <answerId> on MC item <itemId> (<UTC date>), proposed by <workspace>/<tab>`. The prompt files and
     the live tabs follow, as for every change (§1 Delivery). The record becomes `filed`, with the SO-n. Text beside
     Yes reaches the SM with the answer, and it does not change the order.
   - **No, or text with no option:** nothing is filed. The record becomes `declined`.
   - **The add is refused** (`so-too-large`, `so-unreadable`, or a duplicate filed after the proposal): nothing is
     filed. The record becomes `not-filed`, with the code and the message.
   - **One order for one answer.** Before the add, the step looks for an order, active or struck, in any file, whose
     source names the answer id. If it finds one, it records that SO-n and adds nothing. The look-up and the add run
     under one hold of the order files' host lock. So the route step and the pass file at most one order together.
   - The owner's Yes files the order also when the selection moved, or the SM cancelled the item, after the answer.
     The owner's answer is the authority; the proposer only writes the draft. A strike is the only undo.
7. **Timeout and withdrawal.**
   - If no answer arrives in 72 h after the item opened, the proposal expires. The pass cancels the item with the
     server event `system:so-proposal:expire:<itemId>` and the reason
     `Proposal expired after 72 h with no answer: nothing filed.` The record becomes `expired`. The answer route then
     refuses a late answer, because the item is no longer open.
   - The SM can withdraw an open proposal with `attention.cancelled`. The record becomes `withdrawn`, and nothing is
     filed.
8. **Who learns the outcome.**
   - The SM gets the answer as it gets every answer of its run. A filed order also reaches it in the `standing-order`
     line that every live tab gets. For `expired` and `not-filed`, which no answer explains, the proposer tab gets one
     line through the tab event router, kind `standing-order`:
     `[purplemux standing order] proposal <itemId> <expired after 72 h | not filed: <reason>>: nothing filed`.
   - The owner sees the outcome on the item, which serves `proposal: {state, orderId, reason} | null`. The web card and
     the phone show "Filed as SO-n" or "Not filed: <reason>". `so list` shows the filed order with its source.
9. **The audit row.** Each step appends one line to `~/.purplemux/audit/coordination.jsonl` through
   `appendCoordinationAudit`. The line holds `event` (`so-proposal-opened`, `so-proposal-filed`, `so-proposal-declined`,
   `so-proposal-expired`, `so-proposal-withdrawn` or `so-proposal-not-filed`), `itemId`, the proposer's workspace, tab
   and identity, `answerId`, the answer's actor, `orderId`, `reason`, and the sha256 of the order text.
10. **ADR-0021 holds.** The SM writes only in its own workspace: the item opens on the SM's own run. The fleet file
    changes on the owner's answer, which the human answer route authenticates (the session cookie and the same
    origin). As ADR-0021 says, this is harness policy. A seat that obeys the rules cannot file a fleet order without
    the owner. The policy does not stop a hostile process under the same Unix account, which can read the admin
    token today.

**Interim workaround (in force now).** An owner rule for every seat goes in as workspace orders. Each orchestrator
adds the order to its own workspace with `so add -w <WS> --text T --source <owner message id>`, which §1 already
permits. Examples: SO-10 and SO-11 in `ws-L7eUOX`, whose sources are the owner messages `havmSUlPTFqnamLTshs1b` and
`_zAbKJjbrTzijkZlZc1HP` of `ws-zOfVyu`. The cost: one order per workspace, and a workspace whose orchestrator does not
add the order does not get it.

**Tests the follow-on epic writes.**
1. Authority (`tests/unit/lib/standing-orders.test.ts`): only the launch tab of the selected SM proposes. The server
   refuses with `forbidden` a worker tab of the SM's workspace, the orchestrator of another workspace, a hook-identity
   tab, the SM after the selection moved, and the admin token. No item opens, and nothing is filed.
2. The item: format 2, `confirm`, class `scope`, no `defaultOptionId`, no recommended option, and the reserved id. It
   opens on the run of the SM workspace's orchestrator, with the review and the owner push, and with no opener row: a
   NEEDS-DECISION line of the SM in the same turn opens its own item. The context quotes the record's text byte for
   byte.
3. Each check before the item opens, with its code, its exit and nothing written: `so-invalid`, `so-too-large` with
   the size, `duplicate`, `open-proposal`, `no-orchestrator-run`.
4. Reserved prefixes: the events validator refuses an `attention.opened` or `attention.updated` of a `so-proposal-`
   item from a tab or a token, also one that only adds a default or changes the class.
5. The ADR-0031 rule on at 1 minute: after any wait, the proposal is not an auto-answer candidate, and
   `submitSystemAnswer` on it is refused.
6. Yes: exactly one fleet order, with the record's text, scope and check, and the answer id in its source. Every
   workspace's prompt file is written again, each live tab gets one line, one `so-proposal-filed` audit row is written,
   and the item serves `filed` with the SO-n.
7. One order for one answer: a replayed submission files nothing more. A crash after the add and before the record
   update, then the pass, files no second order. The route step and the pass at the same time file one order.
8. Yes after the budget filled up since the proposal: `not-filed` with the measured size, one line to the SM, one
   audit row, the reason on the item, and the fleet file unchanged.
9. No, and text alone, file nothing (`declined`). Yes with text files the quoted text unchanged.
10. Timeout: at 72 h the server cancels the item, the record is `expired`, nothing is filed, and a later answer is
    refused. Withdrawal: the SM's cancel gives `withdrawn`, and nothing is filed.
11. The admin-token way: the tests at `standing-orders.test.ts:227` and `cli-so-wait.test.ts:120` stay green unchanged.
12. CLI (`tests/unit/bin/cli-so-wait.test.ts`): `so propose` prints the item id and exits 0, 2 or 3 by case.
    `tests/unit/bin/cli-exit-codes-doc.test.ts` finds `so-proposal-refused` in the ADR-0016 table and the api-guide.
13. Web and phone (purplemux-mobile): the card shows class Scope, no default and the quoted text. After the answer it
    shows "Filed as SO-n" or "Not filed: <reason>". New fixtures `tests/fixtures/mc-question-v2/so-proposal-*.json`
    drive both.
14. Rollback: a release from before the follow-on epic opens a database with `mission_so_proposals`.

**Consequences.**
- An owner rule for every seat costs the owner one tap. It reaches every Claude tab as one fleet order, with the
  owner's answer as its source.
- A release rolled back onto the database ignores `mission_so_proposals` and runs no answer step, so a Yes stored under
  that release files nothing at that time. After the roll forward, the pass files that Yes, because its record is
  still `open`.
- `SCHEMA_VERSION` stays 4. The curator (ADR-0042) does not change: it files workspace orders only.
- This amendment does not decide a proposed strike. The admin token strikes a fleet order, as before.

**What proves it wrong.** In the 14 days after the deploy, more than 1 proposal in 5 is answered No or expires: then
the SM proposes rules that the owner did not give. Or the owner still sends one rule as notes to more than one seat:
then the proposal costs more than a note.
