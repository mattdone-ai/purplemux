# ADR-0042: Curator routing of owner messages, and the question reshape

## Status
Accepted (2026-11-03, epic `harness-flow-loop`, story 23; architecture ADR-HFL-05 decision 7, ADR-HFL-06, ADR-HFL-11
rule 3). The v2 rule is consult `HFL-consult-v2-open-points.md` point 6. The v2 candidate trigger and the reshape gate
are the story's architect consult of 2026-11-03 (C1, C2). Builds on ADR-0038 (the curator, its gate and per-version
shadow) and ADR-0041 (standing orders).

## Context
ADR-0038 labels, logs and gates; nothing routes. The owner repeats rules (123 repeats in the top-5 clusters in 14 days)
and reads questions whose labels run past 60 characters. Today no curator task passes its gate. The match-standing-order
task needs about 100-125 days of shadow labels. So routing must ship dark. It routes only for a task in state `routing`,
on the version it was promoted on, in a workspace that opts in. treasury-v2's owner rules live in its own decisions
record, which the curator must not bypass.

## Decision
1. **When a label routes.** The label must come from the curator, never from the rules. The rules passed no gate, and a
   keyword match must never file an order. `classify-owner-message` must be `routing`, and the call's served version must
   equal `promotedPromptVersion`. The workspace must be in `curator.routing.workspaces`. Otherwise the call record is the
   whole log, and no routing row is written. Once the task routes, each decision is one `tab_events` row (class `log`,
   kind `curator-route`) holding `{ task, sourceId, label, promptVersion, action, target, reason? }`. It holds no text.
   Like `curator` rows, these rows are never counted as an event sent to a tab or as an effect firing.
2. **Actions** (ADR-HFL-05 decision 7). Classification runs after the history entry is saved, and the route does not
   await it.
   - `standing-order`: an active order of the workspace or the fleet with the same normalised text (one line, case and
     trailing punctuation ignored) means "already filed SO-k", and nothing is filed. Otherwise the keep-or-strike item
     must be able to open (an orchestrator with a bound run) before anything is filed, else `not-filed` with the reason.
     The message, collapsed to one line of at most 600 characters, is then added as `SO-n` in the workspace's file, with
     source `owner message <ws>/<id> (<date> UTC), filed by the curator`. It is active at once: the prompt files are
     refreshed and live tabs get one urgent line (ADR-0041). An item that still fails to open strikes the order again.
     If that strike also fails (a double fault), the route records `filed-no-item` with the SO-n as its target and the
     server logs an error; the order stays active until it is struck with `purplemux so strike`.
     The server also opens one MC item, `curator-so-<n>`: format 2 `confirm`, class `bookkeeping`, default `keep`,
     "Filed SO-n from your message: keep or strike". It opens on the orchestrator's bound run under the reserved
     event prefix `system:curator-so:`, with no opener. The `curator-so-` item-id prefix is reserved: the events
     validator refuses an `attention.opened` or `attention.updated` of such an item from any opener but this one. An
     owner `strike` on the answer route strikes the order only when the order is in the item's own workspace file (never
     the fleet's or another workspace's) and its source names the curator and the message the item names; otherwise the
     strike is refused and logged (`strike-refused`). `keep` and the bookkeeping auto-answer change nothing.
   - `product-rule`: appended to `~/.purplemux/workspaces/<ws>/spec-queue.md` under its message id.
   - `answer`: a row in `mission_answer_suggestions`, served as `suggestedAnswers`, on the latest open item that awaits
     the owner and was opened or revised at or before the message. It is never an answer, and the item's revision does
     not move. The web card shows "Your message … may answer this … It is not an answer".
   - `status-ping` and `one-off`: counted.
   - A credential-shaped message is never filed or queued, and neither is an order over 600 characters.
3. **treasury-v2** (consult C1). `curator.standing-order.candidates` (admin-only) names the workspaces that file no SO-n
   and the tab their candidates go to. The default is `ws-ldhziO=v2-scrum-master`. When `classify-owner-message`
   routes, whatever the opt-in, a `standing-order` label in such a workspace becomes one digest-class line to that tab.
   The line names `<ws>/<entryId>`, the span (or `withheld`) and "candidate for /v2-scope". It is sent once per message
   and opens no MC item; the message id is recorded on disk after the send lands (the last 500), so a restart never
   sends it twice. The tab is resolved by name when sending; with no live tab of that name the result is
   `candidate-undelivered`. The tab reads the whole message with `purplemux curator message -w WS ID`, which withholds
   a credential-shaped message. Setting the key replaces the default, so a value must keep the v2 pair. Every other label
   in that workspace follows the opt-in, and ws-ldhziO is not opted in. Removing the entry is how "v2 records its own
   row" takes effect.
4. **The reshape** (ADR-HFL-11 rule 3). `reshape-question` is a curator task.
   - **Lift.** A v1 question is lifted to the format-2 shape with nothing invented: its options as they are, none
     recommended, the answer type its card derives today (action → action-done, no options → text, otherwise multi),
     and no evidence links. A v2 draft is taken as written. A draft whose structure a wording change cannot fix is
     refused before any call. The structure is checked with every text field set to a placeholder.
   - **Reply.** The model answers a JSON schema with one entry per option id, so it can neither drop nor reorder an
     option. A field the draft already states within its limit is kept as written. The context is rewritten only when
     it is over 4,000 characters. A draft is never cut: over 6,000 tokens it is not reshapable, refused before the call.
     A draft whose options or evidence hold a non-object is not a draft.
   - **Preservation check.** It refuses any change to option ids, count and order, `recommended`, `needsText`,
     `answerType`, `kind`, `class`, the default, story ids, the blocking fields, or any evidence URL. The format-2
     validator then checks the draft with the original in `source`. The record carries the verdict label (`reshaped`,
     `not-preserved`, `invalid`) and the draft's sha256, never its text.
   - **mc ask --fix.** Where the task routes, `POST /api/cli/mission-control/questions/reshape` waits at most 60 s in the
     queue and returns the reshaped draft only if the reply's own version still routes there; the CLI checks it again and
     posts it in the same command. Elsewhere it answers
     `shadow` at once and queues the reshape in the background, logged and never returned.
5. **The reshape gate** (consult C2). For the live version H:
   - **The run.** It covers the held-out ids of `eval/reshape-question.json` (MC item ids, built read-only by
     `scripts/curator/reshape-set.ts`) in a fixed hash order, until 100 replies. Only a timeout, a down or a drop is a
     non-reply; an unparsable reply or an error is a failed reply. More than 10 non-replies before the 100th refuses the
     run. All 100 replies must be schema-valid and preservation-clean, and a failed reply has no draft, so the judge
     counts it as different.
   - **The judge.** An Opus 5.5 high judge reads the drafts from `curator reshape-pairs`, which prints to stdout from
     server memory. Its verdicts reach the file only through `curator judge-import` (admin), bound to the run id and each
     sha256. At least 95 of 100 must be "same decision, same options"; a missing verdict counts as different.
   - **The shadow.** 72 h since H's first live `--fix` call, and every live reply of H clean (an unparsable reply or an
     error is a failed live reply).
6. **The correction rule** (ADR-HFL-06, "what proves it wrong"). A strike from a keep-or-strike item is a correction of a
   routed label. If more than 2% of the week's filed orders are struck, `classify-owner-message` is demoted to shadow.

**Note (story 36, 2026-11-04): owner messages have stable ids and a list.** The `<ws>/<id>` this ADR's actions cite is
a `message-history.json` entry id. A re-send of the same text used to replace the entry under a new id, which orphaned
an earlier citation. It now keeps the entry's first id and takes the new `sentAt`. The entry also records the tab the
input sent to (`tabId`, null when the sender names none). `purplemux owner messages -w WS [--since ISO] [--json]`
(`GET /api/cli/owner/messages`) lists the workspace's prompts oldest first with id, time, tab and text, so a tab can cite
an owner message by its id; a credential-shaped message is withheld there, as `curator message` refuses it. A re-sent
message is classified again under the same id; filing stays deduplicated by text (decision 2).

## Consequences
- Nothing routes today: no task is promoted and no workspace opts in.
- When a task is promoted, an admin opts one workspace in, and every action is reversible: a strike, a struck line in
  the spec queue, or a suggestion that is ignored.
- The classifiers' prompt versions are unchanged from story 16: the hash of their prompt identity is byte-for-byte the
  same object, so their clocks and evidence carry over.
- The matcher still matches against the seed orders it was labelled against (ADR-0038 §3). Moving it to the live order
  store changes its version and needs the set relabelled for the changed orders, so that is left to its own label pass.

## What proves it wrong
- More than 2% of filed orders are struck in a week. The rule demotes the classifier.
- After 14 days at min-version 2, the owner still answers more than 10% of items with "Other" text that restates an
  option (ADR-HFL-11).
- A reshaped item is answered on an option whose wording changed its meaning, as the judge or the owner reports.

## Rollback
- Demote the task (`curator demote --task T`), or remove the workspace from `curator.routing.workspaces`.
- A server rolled back past this ADR ignores `mission_answer_suggestions`, `curator-route` rows and the reshape files.
