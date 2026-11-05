# ADR-0037: Mission Control question format v2

## Status
Accepted (2026-11-03, epic `harness-flow-loop`, story 31; architecture ADR-HFL-11 decisions 1-5). Amends
`docs/mission-control-contract.md` and ADR-0031 §1 (its refusals are now `question-invalid`).

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
