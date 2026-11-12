# ADR-0013: notes route to the epic owner; the body is pulled, never typed

_Epic story: 10 — see `_output/purplemux-portfolio-coordination/stories/10-notes-with-ack.md`._

## Status
Accepted (2026-09-26, epic `purplemux-portfolio-coordination`, story 10).

## Context
At least six cross-epic notes written on 2026-09-25 were never read: pft-1162 → ddh, pft-1376 → pft-1386 (the DLQ filter), reply-2 I1/H12 → pft-1386 before its merge, B5 → DCM, B5 → PBA, pft-1087 → pft-1376. A file in `portfolio-*/` has no delivery path, and the drive guard (correctly) refuses cross-workspace input. On 2026-09-26 the portfolio moved every epic into one workspace, so a workspace is not a stable address for an epic either.

## Options
1. **Type the body through the inbox.** Breaks the inbox's no-caller-text rule (ADR-0012) and floods a composer.
2. **Route by workspace only.** An epic moves between workspaces.
3. **A file drop with a watcher.** Exactly the 2026-09-25 failure: nothing reads it.
4. **A note store; route to the owner at delivery time; type only a fixed notice.**

## Decision
Option 4.
- `note send --to-epic <slug>` first resolves the live holder of `epic:<slug>` (ADR-0011). A same-workspace note goes directly to that holder. A cross-workspace note goes to the holder workspace's enabled, live orchestrator; it never falls back to the worker holder. `--to-workspace <ws>` likewise resolves to that workspace's enabled, live orchestrator. With no live recipient the note is `undeliverable` with a reason — listed, never dropped. The lease store's acquire hook routes an epic's waiting notes the moment the epic is claimed; a 15 s tick covers everything else (orchestration turned on, a re-route, the clock).
- A cross-workspace send, or a send to an epic whose workspace is not yet known, is accepted only from the verified tab currently designated as the source workspace's orchestrator. The admission is stored on the note, so a later source-orchestrator handover does not revoke it. Local workers may continue to send within their own workspace. The admin token and unverified callers are not cross-workspace identities.
- The recipient tab receives only the inbox's fixed line (ADR-0012), whose event is a server enum: `delivered` `[purplemux note n-…] from <ws>/<tab> at <time> — purplemux note show n-…, then purplemux note ack n-…`; `reminder` (to the recipient); `unacked` and `expired` (to the sender). The subject and the body are never typed. An epic slug is not typed either: any tab may hold `epic:<words>` (ADR-0012 amendment). `note list` and `note show` display them.
- `--from-epic` is accepted only from the holder of that epic lease; the note then records the epic as its sender's.
- Every note notice has a paste-time preflight inside the inbox dispatch lock. It re-reads the note and current coordinator mapping immediately before paste, then holds the note lifecycle until the inbox records the paste outcome. An ACKed, expired, superseded, policy-blocked, or old-recipient notice is dropped instead of typed. A queued or held notice is withdrawn when the target coordinator changes or orchestration is disabled; the note re-routes or becomes undeliverable. Notes register this preflight and finish their initial reconciliation before the inbox starts draining on boot. Legacy cross-workspace notices without persisted admission fail closed as `policyblocked` for coordinator resubmission; a line already delivered before this policy cannot be recalled.
- If the inbox drops the notice (its tab closed before delivery), the note returns to `queued` and routes again. A missing inbox item re-routes only if the line never reached a composer: the inbox prunes delivered items after 7 days, and that is not a drop. A tab whose workspace layout cannot be read is unknown, not closed, and nothing is decided on it.
- Two clocks, one shot each (review round 1). The recipient's reminder starts when the line reached its composer (the inbox item's `deliveredAt`): a busy recipient is not reminded of a line it has not seen, and a closed recipient tab is not reminded at all. The sender's notice starts at the first routing (`routedAt`, kept across a re-route): a recipient that never goes idle is exactly the case the sender must hear about. One reminder per recipient at 30 min; one notice per note to the sender's tab (if live) at 60 min; no more. A reminder or a sender notice whose tab state is unknown waits for the next pass instead of being used up; an unknown recipient never holds back the sender's notice; expiry waits up to one day for a sender whose liveness is unknown, so its one notice is not lost. Each completed step is saved even if a later step of the same pass fails.
- `note list --to-me` is the tab the note was routed to, not the workspace: the portfolio's epics share one workspace. A token with no tab reads its workspace.
- Epic slugs use the lease grammar (`EPIC_SLUG`, ADR-0011), so any holdable epic is addressable.
- A sender holds at most 50 open notes; the 51st is refused with `note-cap` (exit 3). One tick runs at a time; a tick asked for meanwhile runs once afterwards. Each pass makes the notes' own inbox and live-tab reads once, and resolves each epic holder and orchestrator once (an epic holder's lease view reads the live tabs on its own; the next pass settles any lag).
- Authorisation: `note send` — local resolved callers inside one workspace, or the verified current source orchestrator across workspaces; `note show` — the recipient workspace, the sender workspace, or admin (else exit 3); `note ack` — the recipient workspace for local notes, but only the verified currently routed coordinator for cross-workspace and legacy unknown-source notes, and only a delivered note (else exit 3). Coordinator ACK reads one mapping snapshot and holds its mapping read lease through the terminal note write. An unknown id exits 7.
- Bounds and retention (B-2): subject ≤ 120 characters with control and format characters removed; body ≤ 16 KiB UTF-8 (exit 2); acked notes are pruned 14 days after the ack; a note unacked or undeliverable 14 days after creation becomes `expired` (one notice to a live sender) and is pruned 14 days later.
- Store: `~/.purplemux/notes.json`, one process-wide lock. A malformed file is refused, not read as empty (the next write would erase it). Lock order is notes → inbox, never the reverse.

## Amendment: the `acked` sender event (2026-11-05, epic `harness-flow-loop-2`, story 06, D17)
At 05:42Z on 2026-11-04 a GO sat about 20 min in the ack comment of n-vaIIdwqlw9: nothing told the sender that the note was acked. Ruling R-06 delivers the comment to the sender and scans none of its words.
- An ack with a non-empty comment queues one `acked` notice to the sender's own tab: `[purplemux note n-…] acked by <ws>/<tab> at <time> with a comment — purplemux note show n-…`. A tab-less acker reads `<ws>/workspace`.
- The comment is the acker's text, so it is never typed (ADR-0012). The sender reads it as `ackComment` with `note show`. An earlier shape typed the clipped comment; the architect consult rejected it for the reason review r1 (H4) rejected a sanitised subject.
- The notice is queued when the sender's tab is live or its state is unknown. The inbox refuses an unresolved target and drops the item only when it sees the tab gone. Nothing is sent to a closed tab, to a sender with no tab, to the tab that acked its own note, for an empty comment, or for a repeated ack. There is no fallback to an epic holder or an orchestrator: an epic holder in another workspace cannot `note show` the note, and one orchestrator would receive every gone worker's acks.
- The paste preflight passes an `acked` notice only while the note is `acked` and the item still targets `note.from`. A failure to queue the notice never fails the ack.

## Consequences
- A note's stored `state: "delivered"` means its notice was routed. Since 2026-10-08 a response reports the stored value only after the notice reached a composer. Before that it reports `pending`, or `held` while the inbox holds the notice (`n-xVHNr3aVfm` read `delivered` while its notice was held). `ack`, `--open` and the paste preflight still read the stored value. `receipt.routingStatus` makes that explicit; only `deliveredAt` / `receipt.composerDeliveredAt` means the notice reached a composer. The receipt projects only this note's inbox item state, refusal, held reason, and delivery time, never the recipient's general inbox.
- The drive guard is untouched: a note never uses the drive path, and nothing a sender writes is typed into another workspace's tab.
- Agents are told at turn start to run `note list --open --to-me` (both agent prompts and the API guide); story 18 carries the command-body side.

## Amendment: an ack wakes nobody (2026-11-10, epic `delivery-flow-fix`, story F6)
The 2026-11-05 amendment above is withdrawn. On 9 Nov one coordinator session took 188 turns that only read an ack
notice, and 646 of 1,286 note lines to the three coordinators in 24 h were ack notices.
- An ack is the store transition alone. It types nothing into the sender's tab. The sender reads the state, `ackedBy`
  and `ackComment` with `note list --from-me` or `note show`.
- The `acked` note event is deleted from the inbox templates. An `acked` notice queued before this release is rejected
  by its paste preflight (`note-ack-notice-retired`): it is withdrawn, never refused, so it neither reaches the sender
  nor blocks the head of the sender's queue.
- D17's case (a GO that sat in an ack comment) is closed by the rule, not by a wake: a reply that the sender must act
  on is sent as a note, or as a Mission Control answer, never as an ack comment.
- F10 step 3 maps `note ack` onto a message's `delivered → processed` write; this amendment adds no ack path for it to
  replace.

## Amendment: a coordinator may point at its own undelivered note (2026-11-10, story vel-G7-POINTER)
A note's notice reaches a composer only through the inbox, and the inbox types only into a ready, empty composer
(ADR-0012). A coordinator that stays busy for an hour therefore never receives a decision note: on 10 Nov the oldest
undelivered decision note at a coordinator was more than 60 min old. A `tab send` reaches a busy tab, but the API
confines agent mutations to the caller's workspace, and that boundary stays.
- `note point <id>` (`POST /api/cli/notes/<id>/point`) types ONE fixed line for the note into its recipient
  orchestrator, busy included. The caller is the verified, live orchestrator of its own workspace (not admin, not an
  owner-granted tab that is not the coordinator). The note is the caller's own, `delivered` (routed) and not yet in
  any composer; its current route (`recipientOf`) is its routed recipient, the enabled orchestrator of another
  workspace. The caller chooses neither the text nor the tab, and the request carries no body.
- The line is an inbox note template: `[purplemux note <id>] from <ws>/<tab> at <time> needs action now: run
  purplemux note show <id> now, then purplemux note ack <id>`. Only a note sent under an owner grant says "carries an
  owner decision": a coordinator's admission says nothing about who decided.
- The target checks are the inbox dispatcher's with `busy` admitted and one look: an agent tab, the dispatch policy,
  no usage-limit halt, no native prompt, not `needs-input` or `startup-prompt`, no option list and an empty composer
  on the screen. The ready-only rule of the inbox itself is unchanged.
- Lock order: the target's dispatch lock, then the notes lock, as the inbox takes them before its preflight. Every
  check runs again inside both. The caller's mapping lock is never held.
- Bounds, in memory: one pointer per note and one per target tab per 10 min (`COORDINATOR_WINDOW_MS`), checked and
  stamped inside the locks, and spent only when text was typed. A submitted line claims the coordinator window.
- A submitted line is the note's composer receipt: `deliveredAt` is stamped, so the reminder clock starts, and the
  queued notice is withdrawn (`note-pointed`). A line left in the composer stamps no receipt and answers
  `typed-not-submitted` (exit 1). Each outcome writes one `note-pointer` coordination audit line.

## Amendment: pending notes are read where the coordinator reads, and an undelivered note escalates at 15 min (2026-11-10, story vel-G7-PENDING)
A status line is read by a person, not by the model, and a hold after 30 inbox refusals (about 2.4 h) is too late
for an owner decision. Readers only: no new store, no new queue, and no change to
the inbox's ready-only rule.
- A coordinator's digest (a tab the coordinator window governs) carries, under its `DIGEST` header,
  `N notes pending, oldest <age>: run purplemux note list --open --to-me`. A watchdog nudge typed to it carries the
  same line after the nudge. The count is the open notes routed to that tab, exactly what the command lists; the age
  is the oldest one's, from its creation, in whole minutes. The ledger keeps the nudge's own text, so the duplicate
  filter and the nudge history read the same row as before. No pending note, or an unreadable note store, types the
  message without the line.
- The two-clocks rule above changes for the sender only: its one notice per note comes at 15 min after the first
  routing when the line has not reached the recipient's composer (`deliveredAt` null), as the new `undelivered`
  event: `[purplemux note n-…] you sent it at <time>; it has not reached its recipient's composer after 15 min —
  purplemux note show n-…`. A line in a composer keeps the 60-min `unacked` notice. It is still one notice per note
  (`senderNotifiedAt`). The paste preflight rejects an `undelivered` notice once the line reached the composer.
- With the `undelivered` notice, the portfolio Scrum Master seat (the current manager selection) gets one digest line,
  `note n-… from <ws>/<tab> to <ws>/<tab> has not reached its recipient's composer after <n> min; its sender was told`:
  ids and times only. The seat gets no copy of a note it sent or that waits for it. The alert is not awaited inside
  the notes lock: a digest takes a dispatch lock, and the inbox takes those two locks in the other order.

## Amendment: a bounced note alerts its sender at once (2026-11-11, stories vel-NOTE-BOUNCE-ALERT, vel-G7-ALERT-WORDING)
An undeliverable note was visible only in the send's JSON answer and in `note list`. A coordinator's notes to an
epic that nobody held stayed `target-epic-unowned` for about 2.5 h, and nobody saw them.
- A note bounces when it becomes `undeliverable` with the reason `target-epic-unowned` or
  `target-coordinator-unavailable`: at the send, or at a later pass when its recipient is gone and none replaces it.
  A policy block is not a bounce. A typed worker event with no recipient is refused and stores nothing, so it does
  not bounce either.
- At the bounce, the sender's live tab gets one inbox notice, the new `bounced` event:
  `[purplemux note n-…] you sent it at <time>; it bounced (<reason>): <words> — it waits for a recipient until it
  expires; purplemux note show n-…`. The same tab's digest gets one line:
  `note n-… bounced at <time> (<reason>): no live recipient; it waits for one until it expires — purplemux note show n-…`.
  Neither line types the epic slug. The paste preflight rejects a `bounced` notice once the note has a recipient again.
- One alert per bounce. A note that routes again and bounces again alerts again. The bounce is always recorded; the
  note's `bounceNotifiedAt` is set once the sender is told, or has nobody to tell (no tab, or its tab closed). An
  unknown sender tab, or a failed notice, at the send or at a pass, leaves it null, and each pass tells the sender of
  any bounced note whose `bounceNotifiedAt` is null. A route or a re-queue resets it. A failed notice never fails the
  send. A note stored before this change has no `bounceNotifiedAt` and owes no notice.
- The Scrum Master seat's `undelivered` line now says `its sender was told` only when a notice went out, else
  `its sender has no live tab and was not told`. Both digest lines carry a fixed time, not an age:
  `… has not reached its recipient's composer since it was routed at <time>; …`. The text is fixed per note, so the
  router's duplicate filter (same tab, kind and text inside 15 min) logs a repeat alert as a duplicate.

## Amendment: owner items reach a busy orchestrator, acks are recorded, and inboxes are counted (2026-11-12, PMUX-NOTE-DELIVERY)
Measured on 12 Nov: seven notes from the Scrum Master seat to one orchestrator waited, the oldest 37 min, among them
the owner's answers. The orchestrator's turns are long, and the inbox types only into a ready composer. The 15-min
`undelivered` notice worked, but it was too late for an owner item. A design consult (Opus 5.5 xhigh) ruled
APPROVE-WITH-CHANGES; the changes are in this amendment.

**1. The owner item.**
- `note send --owner-item` (`ownerItem: true`) is accepted only from the verified current orchestrator of the
  sender's own workspace, the check `note point` uses. The Scrum Master seat qualifies (ADR-0045 §1).
- Every other sender gets 403 `forbidden` and one `owner-item-refused` audit line, and nothing is stored: a worker,
  the admin token, an unverified tab, a human session, a server-local send, or an owner-granted tab that is not its
  workspace's orchestrator. Any value other than `true` is 400 `note-invalid`.
- The note routes as before. Its inbox notice is the fallback, and that notice still waits for the window.
- The server points at the note through the G7 pointer path: once after the send's lock is released, and on every
  notes pass after the pass releases the notes lock. Calling it inside the pass would deadlock: the inbox takes the
  dispatch lock first, then the notes lock. The authority is the stored flag.
- The owner item is armed while all of these hold:
  - it is routed to another workspace's enabled orchestrator;
  - its line has not reached that composer;
  - its notice is queued or held by a recoverable hold;
  - it has no pointer stamp on that route.
- Per target per pass, oldest first, and every check runs again inside the target's dispatch lock and the notes lock.
  The note's own checks run before the target's. A note refused for itself (disarmed, or its line refused) keeps its
  reason and does not block the next owner item for that tab (review round 2). A refusal of the target, a typing, or
  the spacing ends the target's turn: the next note would meet the same tab.
- The line says that the sender flagged it, not that the owner decided:
  `[purplemux note <id>] from <ws>/<tab> at <time>, flagged owner item, needs action now: run purplemux note show <id>
  now, then purplemux note ack <id>`.
- An owner line neither waits for the F6 coordinator window nor claims it. A claim every 60 s would move the window
  forward and starve the target's digests. This narrows F6's "the owner's GO note included" for this one line only.
  An owner item comes from the owner through the seat, and its count is capped, so it passes F6's exemption test.
- Bounds:
  - At least 60 s (`OWNER_POINTER_SPACING_MS`) between any two pointer lines at one tab, manual or owner item, from
    any sender.
  - At most 5 armed owner items per sender (`note-cap`, `owner-item-cap`). The cap counts armed items (routed, not yet
    in a composer, pointer not spent), not open ones, so a note that was read but never acked does not block the sender
    for 14 days, and a bounced one does not count either (review round 2). When bounced notes route at once, the 60 s
    spacing bounds what reaches one tab.
- The sender's `undelivered` notice comes at 5 min for an owner item. Ordinary notes keep 15 min, because the window
  holds them back up to 10 min by design. Each notice states its own minutes.

**2. One line per note per route, and a guarded Enter (both for `note point` too).**
- Before typing, the pointer stores a stamp on the note: `{ route, at, outcome: 'typing', by }`. After typing, the
  stamp records `submitted`, `stranded` or `unverified`. A note with a stamp on its current route is never typed
  again: not after a restart, not after a crash mid-paste, and not by the other pointer (`note-point-spent`). A
  re-queue clears the stamp, so a handover gives the new orchestrator one line.
- A note whose notice is held `stranded-in-composer` or `transport-uncertain` was already typed. It takes no pointer.
- The old submit pressed Enter, waited 600 ms and pressed Enter again without looking. A mid-turn agent can raise a
  permission dialog in that gap, and the second Enter would answer it. The pointer now works in these steps:
  1. Type the line without Enter.
  2. Capture the screen. Press Enter only when the box holds exactly the line and nothing else (whitespace aside), and
     there is no option list and no permission request.
  3. Capture again. If the box still holds exactly the line, press Enter once more after that capture.
  4. If the line is still in the box after the second Enter, the outcome is `stranded`.
  5. If the line was never seen in the box, a dialog appeared, or a capture failed, the outcome is `unverified`. This
     is never a receipt.
  6. Review round 2: if the box holds any other text (a person typed before, after or inside the line), the outcome
     is `not-clean`: no Enter, nothing cleared, the stamp removed. The note stays armed with the reason
     `composer-not-clean`, and the next attempt waits for an empty composer (`note point` answers
     `note-point-not-ready`, exit 5). A person who then submits their draft with the line delivers it without a
     receipt, and the note may take one more line later: one extra id-only line, never a submitted draft.
- An owner line that is `stranded` or `unverified` sends its sender an urgent `note-pointer-spent` line, and the Scrum
  Master seat gets a digest line. The note leaves the armed set, so it does not block the next one.
- `note point` answers `not-verified` (exit 1) where the screen could not confirm the line.
- Busy typing is admitted for Claude Code tabs only. On 2.1.322 a line submitted mid-turn is queued above the box, and
  the box reads empty again (`tests/fixtures/panes/claude-busy-*.ansi`, captured 2026-11-12). The model ran the pulled
  `note show` when the queued line reached it. No other TUI's mid-turn Enter is measured.

**3. Acks are recorded, never typed.**
- Since F6, `note ack` queues nothing. A newly acked note now also writes one `note-acked` row of class `log`
  (`classifyWake('note-acked') === 'log'`) to the sender tab's `tab_events`:
  `note n-… acked by <ws>/<tab> at <time>[ with a comment] — purplemux note show n-…`. The comment is not in the row.
  A log row is never typed and never in a digest, and with the ledger down it is not typed either.
- At boot, the notes runtime withdraws every queued or held `note:<id>:acked:` item (`note-ack-notice-retired`).
- The held "ack receipts" in an orchestrator's inbox are pre-F6 notices held `stranded-in-composer`. That hold is
  never retried and never reaches the preflight, so it stays in `inbox list` until the 7-day prune. The sweep is
  cleanup: those items blocked nothing.

**4. Counts.** `GET /api/cli/inbox` adds `counts` over every retained item of the workspace, whatever `all` says:
- per state;
- held items by the first word of their reason;
- per target tab.

`inbox list --counts` prints one line per state, then one line per tab.

**Alternatives.**
- Inbox priority for one class. Rejected: it breaks ADR-0012's ready-only rule.
- An urgent tab event. Rejected: the window turns it into a digest row, and the router keeps no note receipt.
- One coalesced line per target. Rejected: the receipt is per note.
- A `PostToolUse` hook that returns `additionalContext`. This reaches the model without the composer, so it has no
  dialog race. It needs a server read on every tool call. It is the follow-up if the race shows up in measurements.
