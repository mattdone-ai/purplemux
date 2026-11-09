# ADR-0037: Mission Control question format v2

## Status
Accepted (2026-11-03, epic `harness-flow-loop`, story 31; architecture ADR-HFL-11 decisions 1-5). Amends
`docs/mission-control-contract.md` and ADR-0031 §1 (its refusals are now `question-invalid`).
Amended 2026-11-04 (defect D2, follow-up questions): see the amendment at the end. Its code is deferred to the
follow-on harness epic.

## Context
The owner (2026-11-03): "Can we improve the questions and make them formatted they are currently hard to read. And
some of the answers won't let me select something." Measured on 578 items (harness-flow-loop research, pack section 7):
24 items have 0 options and 26 have 1; 338 of 1,224 labels are over 60 characters (p90 101, max 292); agents revised
open questions 162 times, and each revision put the owner's draft in `conflict` with Submit disabled until "Update draft
for current question" (`mission-control-answer-card.tsx`, `disabled={... draft.status === 'conflict' ...}`), because
the answer route refused any `expectedRevision` that was not current. The validator allowed a 500-character label, 0-20
options and 8,000 characters of context, and had no field for the decision, the cost of waiting, evidence links, a
per-option consequence or an answer type. The web rendered `context` as plain text.

## Options considered
1. **Client-only rendering of today's fields.** Fixes reading, not the questions.
2. **A curator that rewrites every question.** A model between the agent and the owner changes meaning with no author.
3. **A versioned schema the server enforces, a deterministic lint, an optional reshape that returns to the asking
   agent, a revision rule that keeps the owner's work, one rendering spec.**

## Decision
Option 3.

1. **Schema.** `question_json.formatVersion: 2` marks the new format; an item without it is v1 and keeps the v1 rules.
   Format 2: `decision` (required, one line, at most 120), `whyNow` (at most 200, required on `kind: question`),
   `answerType` (`single` | `multi` | `confirm` | `text` | `action-done`; `action-done` pairs with `kind: action`, every
   other type with `kind: question`), `options` (single and multi 2-4, confirm exactly 2 with Yes/No supplied when
   omitted, text and action-done none; each `{id, label ≤ 60, consequence? ≤ 160 one line, recommended?, needsText?}`;
   at most one recommended on single and confirm), `recommendationWhy` (at most 200, required when an option is
   recommended; replaces `recommendation`, which format 2 refuses), `evidence` (at most 8 `{label ≤ 60, url http(s)}`, each url once),
   `context` (optional markdown, at most 4,000), `source` (the original draft, at most 16,000 characters of JSON). `title`
   (at most 80), `storyIds`, `blockingScope`, `canContinue`, `class`, `defaultOptionId` keep their v1 rules. Unknown
   fields are refused. `consequence` is optional: an option whose label says it all needs none. The served item names
   the evidence links `evidenceLinks`, because `evidence` is already the item's provenance (ADR-0004: additive only).
   `blocked {items, hours, critical}` is served only once the work-item ledger computes it; until then it is absent,
   never 0.
2. **One validator.** `validateMissionQuestion` (`src/lib/mission-question-format.ts`, pure, also read by the web card
   and the CLI's check) runs for `attention.opened` and `attention.updated`. A refusal is 400 `question-invalid` (CLI
   exit 2) with `defects: [{eventId, itemId, field, measured, limit, message}]`, every defect of every event in the
   batch, and nothing written. Fleet config `mission.question-format.min-version` (admin token only; unset, invalid or
   unreadable is 1): at 1 a v1 question is accepted, its format-2 findings return as `lint` in the 200 body and on the
   item as `lint[]` (computed on read, so historical items have it too); at 2 a new v1 question (`attention.opened`) is
   refused, while an `attention.updated` that keeps a v1 item v1 is accepted with its lint and one that would turn a
   format-2 item back into v1 is refused.
   The owner raises it after 48 h of zero lint findings (OD-10).
3. **Check and reshape.** `POST /api/cli/mission-control/questions/check` is the same check without the write;
   `purplemux mc ask -w WS --json @DRAFT [--fix]` runs it, prints every defect and exits 2 with nothing posted, or posts.
   The check answers `reshape: {enabled: false, reason}`; `--fix` prints the defects and the reason and exits 2 until
   the curator reshape (harness-flow-loop story 23) enables it.
4. **Revisions keep the owner's work.** Each `attention.updated` stores a server-computed `changes` record (`decision`,
   `answerType`, `options.added/removed/relabelled` with any `needsText` flip, `recommended`, `recommendation`, `whyNow`,
   the v2 `title`, `context`, `evidence`, `compatible`) in the unversioned side table
   `mission_item_changes(item_id, workspace_id, revision, changes_json, at)` and on its event; the item serves the latest
   as `changes`. Compatible means the decision (the title on v1), the answer type (derived on v1: action is
   `action-done`, no options is `text`, otherwise `multi`) and every option id are kept. An answer on revision r against
   current r' is accepted when every revision in (r, r'] has a compatible record and every selected option exists; the
   answer stores `appliedRevision` beside `expectedRevision`, and so does `answer.recorded`. A revision with no record
   (written before this ADR, or by the server) counts as incompatible and is listed in `unrecorded`. Otherwise 409 with
   `current` and the merged `changes`. A format-2 answer selects at most one option on single and confirm, and has text
   when a selected option has `needsText` (400). Text alone ("Other") is always an answer.
5. **The card.** Decision first, then `whyNow`, the blocked cost, evidence links, the markdown context
   (`react-markdown` + `remark-gfm`, `skipHtml`, links in a new tab, collapsed beyond an estimated 12 lines), and
   "Original wording" when `source` exists. `single` is a radio list, `multi` checkboxes, `confirm` two full-width
   buttons; each option a full-width card with label, consequence and a "Recommended" mark; a selected `needsText`
   option opens a required field; "Other" is always last. A compatible revision keeps the selection, the text and the
   answered revision, and marks new and reworded options; an incompatible one keeps the text, clears only removed or
   reworded selections (all of them when the answer type changed), shows the old and new wording and answers the
   current revision. The draft judges compatibility as the server does: each observed step (the question on screen to
   the current one) is merged into the span since the answered revision, and New / Changed marks and clearing follow
   the step. Text typed for an option that no longer takes it moves into "Other" under the option's label, with a line
   saying so; a revision with no visible change shows no notice. A 409 does the same. Submit is disabled only with its reason on screen. v1 items use the same
   layout. Fixtures `tests/fixtures/mc-question-v2/*.json` drive the web tests and the phone's widget tests.

## Consequences
- Unreadable questions stop at the server with a reason the agent fixes in the same turn; until min-version 2 they are
  accepted with `lint`, so no producer breaks on deploy.
- The 162 silent Submit blocks end: no revision leaves the owner without an enabled Submit for an answer that still
  applies.
- `SCHEMA_VERSION` stays 4. A release rolled back onto the file ignores `mission_item_changes`, spreads the format-2
  fields through on read (as ADR-0031 §1), and refuses a format-2 write (`.strict()`).
- Rollout order: no producer posts `formatVersion: 2` before the phone renders it (purplemux-mobile story 32); until
  then the phone reads a v2 item through its v1 fields.
- ADR-0031's refusals of a bad `class` or `defaultOptionId` move from `invalid-request` to `question-invalid` (same 400,
  same exit 2).

## What proves it wrong
After 14 days at min-version 2, the owner still answers more than 10% of items with "Other" text that restates an
option, or reopens items as unclear; or an answer lands on an option whose wording changed under it (a compatible
revision that was not). Then treat a relabel as incompatible.

## Amendment (2026-11-04, epic `harness-flow-loop`, defect D2: a follow-up question links to the answered item)

**Status.** Accepted (2026-11-04). Owner decision: Mission Control answer `8638e767-af5f-4452-8ec1-6e89dee0ab45`
(2026-11-04T02:15:17Z, option `followon`). The answer moved the D2 code to a follow-on epic and asked for this ADR
now. Sources: the triage `_output/harness-flow-loop/briefs/D1-D8-triage.md`, row D2, and the Portfolio SM's defect note
`n-sqL9hVZwJY`, D2. Architecture ADR-HFL-11 decisions 1 and 4 do not change.

**Deferred to the follow-on harness epic:** all the code and all the tests below (triage estimate: about 180 agent
minutes). Until that epic lands, §4 applies unchanged: an agent quotes the earlier item in the context of a new item.

**Context.** The owner answered `fx-owner-1104` with text alone ("Other", answer `a9ebf5ee`). The text answer set the
item to `answered` (`recordAnswer`, `src/lib/mission-control-store.ts:1516`). treasury-v2 then sent an
`attention.updated` with the facts of the reply. The store refused it, because only open or candidate items can be
updated (`:1169`, pinned by `tests/unit/lib/mission-question-revisions.test.ts:166-172`). v2 opened `fx-owner-1104b`.
The owner saw two items for one question, with no link between them.

**Options considered.**
1. **A text answer that selects no option keeps the item open for a compatible revision.** Rejected, for three reasons:
   - Answer delivery keys on `state='answered'`. The transfer to a new binding (`:1259`), both claims (`:1552`,
     `:1570`) and the delivery check (`:1604`) send an answer only for an answered item. The answer of an open item
     would never reach the agent, unless each of the four guards learns a second state.
   - Text answers are often complete. Both `nd-` answers of 2026-11-04 were text, for example "ok done" on
     `nd-5941c597…` at 01:28:58Z. The item would stay open after a full answer, and the owner would close it by hand.
   - An answer applies to the revision that it answered (`appliedRevision`, §4). A revision after the answer would
     change the question under the owner's answer.
2. **No change: the agent opens a new item and quotes the earlier item in its context.** Rejected: that is the defect.
   The owner sees two items for one question, and nothing ties them.
3. **`mc ask --follows-up <itemId>`: the new item links to the answered item and resolves it in the same
   transaction.** Chosen.

**Decision.** Option 3. The last rule of §4 stays: text alone ("Other") is always an answer, and it sets `answered`
(`mission-question-revisions.test.ts:202`).

1. **The event field.** `attention.opened` takes an optional `followsUp: <itemId>`, beside `itemId` and `humanReview`.
   The field is not part of the question: `validateMissionQuestion`, the content hash, the `changes` record and the
   lint do not see it. `attention.updated` refuses the field with 400 `invalid-request` ("followsUp is set when an
   item opens; a link never changes").
2. **The CLI.** `purplemux mc ask -w WS --json @DRAFT --follows-up <itemId> [--fix]` puts the field on the event. The
   question check (`POST /api/cli/mission-control/questions/check`) takes the field too. It reports a refusal from the
   edge cases below as a defect of field `followsUp`, and it writes nothing. `--fix` keeps the field on the reshaped
   event. (Today `reshapeAsk` in `bin/cli.js` builds the payload from `itemId` and `humanReview` only.)
3. **One transaction.** The store does these steps in the transaction of the `attention.opened`. If one step fails,
   the store writes nothing and refuses the batch (the atomic-batch rule).
   1. It checks the earlier item (the target) against the edge cases below.
   2. It opens the new item, which must be human-visible. The event must carry a `humanReview` with a `humanNeed`
      other than `none`. Otherwise the store refuses it with 400 `invalid-request`: a candidate is not yet a question
      to the owner.
   3. It writes the link in the unversioned side table
      `mission_item_links(item_id PRIMARY KEY, follows_up_item_id UNIQUE NOT NULL, workspace_id, at)`, created with
      `CREATE TABLE IF NOT EXISTS`, as `mission_item_changes` (§4). `SCHEMA_VERSION` stays 4. The primary key gives an
      item at most one predecessor. The unique column gives an item at most one follower.
   4. If the target is `answered`, the store sets the target's delivery to `acknowledged`, as `answer.acknowledged`
      does. Then it resolves the target with the resolution `Followed up by <new item id>.` The store writes this
      change as an `attention.resolved` event with the event id `system:follow-up:<new item id>`. The prefix
      `system:follow-up:` joins the reserved event-id prefixes, so no request may use it.
4. **The asker reads the answer in the reply.** The follow-up acknowledges the target's answer. If the delivery of
   that answer still waits, the server never pastes it (the four guards above). So the 200 body carries
   `followedUp: {itemId, answerId, optionIds, optionLabels, text, resolved}`. The CLI prints it on one line:
   `follows up <id>: the owner answered <option labels, or "text only">: "<text>" (answer <id>); <id> is resolved`.
   A batch with two or more follow-ups (of different targets) carries them as `followedUps: [...]` instead of
   `followedUp` (consult ruling, story hfl2-01, 2026-11-05; additive under ADR-0004).
5. **The served item.** Every item gains
   `followsUp: {itemId, title, answer: {optionIds, optionLabels, text, at}} | null` and
   `followedBy: {itemId, title, state} | null`. Each field names one step of a chain. Both fields are additive
   (ADR-0004).
6. **Both clients show the link.** The web card and the phone (purplemux-mobile) show the same things:
   - The new card shows "Follows up: <title of the earlier item>" above the decision. Under it, the card shows the
     owner's earlier answer (option labels and text) and a link to the earlier card.
   - The earlier card reads as resolved: it shows the state Resolved and "Followed up by: <title of the new item>",
     with a link. It leaves the "Needs you" list, as every resolved item does.
   - New fixtures `tests/fixtures/mc-question-v2/follow-up-*.json` drive the web tests and the phone's widget tests.

**Edge cases.** A refusal writes nothing. A 409 body adds `followsUp: {reason, followedBy?, tip?}`. The refusals use
codes that the ADR-0016 table already maps (`invalid-request` exit 2, `forbidden` and `conflict` exit 3, `not-found`
exit 7), so this amendment adds no new code.
- **The target is not answered.** A target in state `open` or `candidate` gets 409, reason `not-answered`. The message
  tells the agent to revise the open item with `attention.updated`: a compatible revision keeps the owner's draft (§4).
  A `cancelled` target also gets 409 `not-answered`, because a cancelled item has no owner answer.
- **The target is in another workspace.** 403 `forbidden`, with the ADR-0021 denial: agent mutations are confined to
  the caller workspace. The resolve changes the target's workspace, and the caller's token is scoped to its own
  workspace. The refusal names neither the other workspace nor the target's state. A target on another run of the
  same workspace gets 409, reason `other-run`. An item, its answer and its delivery belong to one run binding, as
  every attention event on an item already requires ("attention item is outside this run").
- **A chain of follow-ups.** A chain A ← B ← C is permitted: B follows up A after the owner answers A, and C follows
  up B after the owner answers B. A second follow-up of A gets 409, reason `already-followed`. The body names B
  (`followedBy`) and the last item of the chain (`tip`, here C). The agent follows up the tip after the owner answers
  it, or revises the tip while it is open. Each card shows one step back and one step forward, and the owner moves
  along the chain by the links.
- **The target is already resolved.** If the target has no follower, the store writes the link only. The target's
  state, resolution and delivery do not change, and `followedUp.resolved` is `false`. If the target has a follower,
  the store refuses it with `already-followed`, as for a chain.
- **A cycle.** A cycle cannot form. The store writes a link only when an item opens, and the link names an item that
  already exists and is answered or resolved. So each link points from a newer item to an older item. No event sets or
  changes a link after the open. A `followsUp` equal to the event's own `itemId` gets 400, because that item does not
  exist yet. Each item has at most one predecessor and one follower, so the links form chains only.
- **Other cases.**
  - A target that does not exist gets 404 `not-found`.
  - Two follow-ups of one target in one batch: the store refuses the second, so it refuses the whole batch.
  - A replay of the same event id and content returns the stored result and writes no second link.
  - A target that the ADR-0031 rule answered is followed up as every answered item is.
  - A `NEEDS-DECISION:` line (ADR-0041 §2) sets no `followsUp`. An orchestrator that wants the link asks with
    `mc ask --follows-up`.

**Tests the follow-on epic writes.**
1. Store tests (`tests/unit/lib/mission-question-revisions.test.ts`, or a new
   `tests/unit/lib/mission-follow-up.test.ts`):
   - An answered target: the new item opens `open`, and the link is written. The target is `resolved` with
     `Followed up by <id>.`, its delivery is `acknowledged`, and one `system:follow-up:` event names the target. A fault
     injected after the link write leaves nothing written.
   - A text-only answer still sets `answered` and is delivered. The tests at lines 166 and 202 stay green unchanged.
   - Each edge case above, with its status, its reason, and nothing written.
   - Cycles: the store refuses a self-link and an `attention.updated` with `followsUp`. A property test over random
     event sequences finds chains only.
   - A follow-up with no human review gets 400.
   - A replay writes one link. A batch with two follow-ups of one target is refused whole.
   - A queued delivery of a target that a follow-up resolved is never claimed (`claimDelivery` returns null), and the
     200 body carries the answer.
   - The snapshot serves `followsUp` and `followedBy`, and null on an item with no link.
2. Route and CLI tests (`tests/unit/bin/`): `mc ask --follows-up` posts the field and prints the answer line. It exits
   0, 2, 3 and 7 by case. The check route reports a `followsUp` defect. `--fix` keeps the field.
3. Web tests: the two cards, from the `follow-up-*` fixtures.
4. Phone widget tests (purplemux-mobile), from the same fixtures.
5. A rollback test: a release from before the follow-on epic opens a database with `mission_item_links` and serves the
   target as `resolved`.

**Consequences.**
- One question shows as one thread. The owner sees the earlier answer on the new card, and the earlier card is closed.
- A release without this code refuses an event with `followsUp`: the v1 and v2 checks refuse an unknown field
  (`question-invalid`). So a follow-up never applies in part. That release ignores `mission_item_links`, and a
  resolved target stays resolved.
- Until the phone story lands, the phone shows the target as resolved and the new item without its link. No state is
  wrong; only the link is absent.

**What proves it wrong.** In the 14 days after the deploy, more than 1 follow-up in 10 gets an owner answer that
restates the earlier answer, or agents still open an unlinked item for an answered question more than twice a week.
Then measure why the asker does not use the link. Do that before you add mechanism.

## Amendment (2026-11-09, story vel-MC-ACT: owner steps and actions in the owner's list)

A recurrence the owner raised. Two things went missing from Mission Control:

1. An owner action written inside a question item closed, undone, when he answered the question.
2. An open kind=action item did not show in his list, though it was listed as open work.

**Case 2's cause.** An attention.opened with no `humanReview` is stored as a **candidate** (`candidateReason: workspace-issue`), whatever its kind. A candidate is the orchestrator's to review and never reaches the owner's Needs you list. That was measured before: an item needs a human review to show. An owner action opened without a review was therefore invisible to the owner until an attention.updated added one.

- **Fix: the server stamps the orchestrator's own owner action.**
  - **Production path:** `mission events` and the events route go through `applyMissionEventBatch`. For an attention.opened kind=action with no `humanReview`, the batch reads two things:
    - the opener's live identity: the opener is the server-resolved caller tab, never a payload claim (ADR-0023);
    - the workspace's configured orchestrator.
  - **When it stamps:** only when the opener IS the configured orchestrator, and its live identity matches the run's binding. These are the checks an explicit review passes. The store then stamps `humanNeed: external-action`:
    - `humanReason` is "An action only the owner can take: <decision or title>." plus its whyNow;
    - `handling` says the server stamped it;
    - `reviewerTabId` is the orchestrator.
    The item opens in the owner's list.
  - **Pinned end to end:** through `applyMissionEventBatch` and the real store, with no injected authority.
- **Anyone else's action is still a candidate.** That covers:
  - a kind=action opened by any other tab;
  - one opened by a server or admin producer with no opener;
  - one opened by the orchestrator tab whose live session no longer matches the binding;
  - any action when no orchestrator is configured.
  Each stays a candidate for the orchestrator's review, as before. Both the events route and `mc ask` (the check route) warn the opener: `humanReview: absent on a kind=action`, naming who makes it visible.
- **After the stamp:** the item is open like any reviewed item. An attention.updated that changes its text needs a `humanReview` again (renewed review, as for every open item).
- **The view.** The Needs you list also renders an open owner item the page holds no draft for yet, from a fresh draft. That closes a one-render gap only; it was not case 2's cause.

**Owner steps are lint, not a refusal.**
- **What is read:** every attention.opened and attention.updated of a kind=question, in its `context`, `decision`, `whyNow` and the options' `label`, `consequence` and `description`. Code blocks are dropped, since they hold quoted text.
- **What counts as a step (round 6):** a clause that asks the owner to act outside his answer.
  - **An imperative** at the start of a sentence, a line, a numbered item, a comma or slash clause, or after a short label ("Your one click: open the run page"), followed by what makes it a command: "Click Approve", "Paste it into", "Open the", "open Environments", "Go to Settings", "Sign in to", "Run the", "Press Squash and merge", "Add the", "Set can_admins_bypass to false".
  - **"you <present verb>" at the start of a clause** ("A one-off: you run the script", "Or you sign in with a role", "If you choose (b), you put the key in"), and **"only you <verb>"** ("which only you can edit").
  - **A phrase that addresses the owner's steps:** "Your steps", "Steps:", "please <do>" (a third party too: "Please ask the vendor to ..."), "you'll need to <do>", "you must <do>", "need you to <do>", "steps from you", and a message for an outside party ("Paste this to the vendor's desk:").
- **What does not count:**
  - A question: a sentence that ends with "?".
  - An imperative in `decision` or in an option `label`: both name the choice ("Select the rollout path", "Merge the PR now"), so there only the phrases count.
  - A lettered item ("(b) add a calendar"): an option of the decision. An imperative there is a step only on the owner's own object ("(a) Add your role as an operator").
  - A past reference: a date or a past marker ("On 21 Oct, you set ..."), or "you" with a past verb ("you wrote", "you ruled", "you asked").
  - "you" that is not at a clause start: a relative clause ("the list you accept"), a condition or a wait ("until you accept", "before you answer"), "that you ..." ("record that you accept").
  - A request for information: "Please tell us whether ...", "please check whether ...".
  - An answer instruction: "Reply with ...", "Type the names in the text box", "Tick ...", "Pick an option".
  - An agent plan: a sentence after "Fix:", "Plan:" or "Recommended:", the items under a "Fix:" or "Plan:" heading line, a sentence led by "I <verb>" that does not turn to the owner, "we <step>" or "we recommend", a role with a step verb ("The role may read the password, open a tunnel"), and a "lets the agent ..." capability list.
  - A verb that is also a noun without its command form: "Run time", "Open question", "Copy of", "Press coverage", "Press on", "Open to", "Go to production", "Sign-in rates", a capitalised heading such as "Press Coverage:".
- **The finding** names the steps, the fields they were found in, and the split. Each owner step becomes its own kind=action item (answerType `action-done`, humanNeed `external-action`), and the question keeps to the decision.
- **The fixture set:** the patterns are tuned on `tests/fixtures/mission-questions/owner-steps.json`.
  - Its positives are the owner-step forms.
  - Its negatives include every false positive the reviews named.
  - Round 4 (PR #60) added one case per shape from a run over the real store (1332 items, 37 hits, about 21 true): the two false-positive shapes above and five miss shapes ("you <do>" mid-sentence, "please <do>" on a third party, a paste-to-a-party message inside a line, a step in an option label, "steps from you"). Round 5 added one negative case per remaining false-positive shape: "you <verb>" or "please <verb>" that is not an instruction (precision was about 66 % at round 4, 94 hits).
  - Round 5 added one negative per "you <verb>" shape that is not an instruction. It was worse on the real store (63 hits, precision about 57 %, and real steps dropped): tuned on descriptions, measured on items the tuner cannot see.
  - Round 6 adds a measurable target: a `labelled` table of 24 owner-step and 24 non-step context sentences, paraphrased from real shapes. The test reports recall and the clean share of negatives; the target is at least 22 of 24 on each side, and every other case still passes. If round 6 does not beat round 4 on the real store, the lint goes back to round 4's rules.
  - Every case is neutral synthetic text modelled on the shapes of real items. The repository is public, so no real Mission Control text goes in, not even with names stripped. The lint is measured over the real items on the control host, outside the repository; only the counts and the shapes it got wrong come back as new synthetic cases.
  - No served question fixture (`mc-question-v2`) is flagged.
- **A heuristic, so it never refuses.** A pattern cannot tell every step from a description of one, and a refused question would hide the decision too. A kind=action item is not read: it is the step.
