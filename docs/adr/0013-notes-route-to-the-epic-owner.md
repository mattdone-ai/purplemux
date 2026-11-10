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
