# vel-RETRO-R3: `tab send` confirms the submission

## Problem
Retro 2026-11-09 row R3: the Scrum Master sent a `/party` brief to a fresh tab. The text was typed into the
composer, the agent never took a turn, and the receiver sat idle for about 15 minutes. `tab send` exited 0.

Today (`src/pages/api/cli/tabs/[tabId]/send.ts`):

1. The `composer-ready` gate (ADR-0007, ADR-0008) reads `cliState` only. A fresh Claude tab turns `idle` on its
   SessionStart hook (`deriveAgentCliState`), which can fire before the TUI takes keys.
2. After `deliverPrompt` (typed text, then `submitComposer`: Enter, 600 ms, Enter), one capture runs at once.
   `submitted` is `!isContentPendingInComposer(...)`, and a capture that fails reads as submitted.
3. The CLI prints the body and exits 0 whatever `submitted` says.

So a send that typed and did not submit answers `{submitted: false}` at best, exit 0, and a caller that reads the
exit code does not see it.

## Sources read (SO-1)
- `src/pages/api/cli/tabs/[tabId]/send.ts`, `src/lib/tab-send.ts`, `src/lib/composer-readiness.ts`,
  `src/lib/automated-prompt-dispatcher.ts` (L37: one more Enter for a stranded nudge), `src/lib/agent-prompt-delivery.ts`,
  `src/lib/tmux.ts` (`isPaneShowingPendingContent`, `isPaneShowingPendingLine`, `submitComposer`, `pressEnter`),
  `src/lib/status-manager.ts` (hook events, `lastEvent.seq`), `src/lib/agent-state-transition.ts`, `bin/cli.js`
  (`cmdTabSend`, the code -> exit table).
- ADR-0004, ADR-0007, ADR-0008, ADR-0009, ADR-0016, ADR-0018, ADR-0022.
- Tests: `tests/unit/api/cli-tabs-send.test.ts`, `tests/unit/lib/tab-send-readiness.test.ts`,
  `tests/unit/lib/pending-composer.test.ts`, `tests/unit/lib/composer-readiness.test.ts`,
  `tests/unit/bin/cli-exit-codes.test.ts`, `tests/unit/lib/cli-tab-send-flags.test.ts`.

## Consult
**Question.** What proves that a `tab send` (CLI route, `composer-ready` gate) submitted its text, and what does the
send do and answer when that proof is missing?

Facts:
- Proof sources available after the typing: (a) a `prompt-submit` hook event whose `lastEvent.seq` is above the seq
  read before the typing (Claude local and remote, Codex); (b) `cliState` that turned `busy` from a state that was not
  `busy`; (c) the screen: `readComposer` answers `empty | text | unreadable`, and `isPaneShowingPendingLine` matches
  the content's whole first line in the input box.
- An empty composer alone is weak: keys swallowed during a boot leave an empty composer and no turn.
- L37 precedent (`AutomatedPromptDispatcher.confirmSubmitted`): when the text is still in the composer after the
  Enter, press Enter once more, then report. It never fails the dispatch.
- ADR-0016 §4: a blind retry of `tab send` can type the prompt twice, so the exit class of a failed confirmation must
  not invite a retry.
- Existing test "reports submitted when the composer probe itself fails" pins today's optimistic read.

Options:
1. **Proof by hook or screen, one Enter retry, fail loud.** Before typing, read `lastEvent.seq` and `cliState`.
   After `deliverPrompt`, poll every 250 ms for up to 5 s: `prompt-submit` seq advanced, or `busy` from not-busy, is
   `confirmation: 'prompt-submit'`; `readComposer = empty` with the first line not pending is
   `confirmation: 'composer-empty'`. If the first line is still pending at 1.5 s, press Enter once (L37) and go on
   polling. At the deadline: first line pending -> `typed-not-submitted`; else `submit-unconfirmed`. The answer stays
   HTTP 200 (the text was typed; ADR-0004 additive fields `confirmation`, `resubmitted`, `notSubmitted`), and the CLI
   exits 1 with the code and a hint "the text is in the composer; do not resend; inspect the tab".
   The readiness gate also requires an empty composer on screen (`paneShowsEmptyComposer`) when `cliState` is `idle`.
2. **As 1, but proof by hook only.** An empty composer never proves a submission. Grok has no prompt-submit hook on
   a remote host, and a hook that spools (server restart) arrives late, so more sends end `submit-unconfirmed`.
3. **As 1, without the readiness screen check.** Keep ADR-0007's `cliState` gate; rely on the post-send check and the
   one Enter retry to repair a boot race.

Acceptance criteria affected: tests ready, not-ready-then-ready, typed-not-submitted, tab gone (exit 4); the
exit-code table (ADR-0016); the phone route (`performTabSend`, `live-session` gate) stays unchanged in every option.

**Ruling** (one `claude -p --model claude-opus-5-5 --effort xhigh` consult, 2026-11-09):

RULING: Option 1, with three changes. Hook-capable tabs need a hook as proof. The screen gate uses the same states as `checkComposerReady`. A Codex tool event does not count as proof.

**Readiness gate (CLI `composer-ready` only).** After the `cliState` test passes, run the screen half of `checkComposerReady` (capture, then `paneShowsEmptyComposer`). Apply it to `idle`, `ready-for-review` and `busy`+`waitingAtPrompt`, the same states Mission Control screens. `needs-input` stays status-only (ADR-0007): an option list there is what the send answers. A failed screen read means not ready. Keep polling every 500 ms. At the deadline, answer `readiness-timeout` (exit 5, nothing typed) with an additive `screen: composer-not-empty | composer-unreadable | interactive-prompt-active`. With `waitMs: 0`, look once.

**Baseline.** Inside the dispatch lock, just before `deliverPrompt`, read `lastEvent.seq` and `cliState`.

**Proof, polled every 250 ms after `deliverPrompt` returns.** The deadline is 5 s for a local tab and 10 s for a remote one.
- A `prompt-submit` with seq above the baseline and without `fromTool`, or `busy` from a non-busy baseline, gives `confirmation: 'prompt-submit'`. Answer at once; this wins over any screen reading. If `lastEvent` does not keep `fromTool`, the story records it.
- `composer-empty` counts only on a tab with no prompt-submit hook: `grok-cli` on a remote host. `hasPromptSubmitHook(tab)` decides this and has its own unit test. On a hook-capable tab, an empty composer is never proof.
- `unreadable` is never proof. Replace the test "reports submitted when the composer probe itself fails" with "a failed probe is not proof → `submit-unconfirmed`".

**Enter retry (L37).** Press Enter once, at the first poll at or after 1.5 s, if either is true:
- the first line is still pending, or
- `readComposer = text` and the gate saw an empty composer. This catches the `[Pasted text]` placeholder, where the first-line match fails.

Never press it a second time. Set `resubmitted: true` and keep polling.

**At the deadline.** First line pending, or `text` after an empty gate read → `typed-not-submitted`. Anything else → `submit-unconfirmed`.

**Wire (ADR-0004, additive).** The answer stays HTTP 200 `status: 'sent'`. `submitted` is true only with a proof. Add `confirmation: 'prompt-submit' | 'composer-empty' | null`, `resubmitted: boolean` and `notSubmitted?: <code>`.

**CLI.** `cmdTabSend` prints the body to stdout, then, if `notSubmitted` is set, calls `fail(code)`. Add both codes to `CODE_EXIT` as `EXIT.UNEXPECTED` (1) and to `CODE_HINT`:
- `typed-not-submitted`: "the text is in the composer; do not resend; inspect the tab"
- `submit-unconfirmed`: "the text was typed and no turn was seen; do not resend; inspect the tab"

Add one ADR-0016 exit-1 row for each code; `cli-exit-codes-doc` enforces this. Exit 5 is wrong here: its hint says "retry", and the text is already typed (§4).

**Phone route.** `performTabSend` and the `live-session` gate stay as they are.

**Tests to pin:**
- ready → `prompt-submit`, exit 0
- not-ready-then-ready, two cases:
  - `idle` with no composer drawn, then a composer → typed once
  - composer not empty until the deadline → exit 5, nothing typed
- typed-not-submitted → exactly one extra Enter, exit 1
- placeholder `text` → one Enter
- a `fromTool` seq advance → not proof
- remote Grok `composer-empty` → exit 0
- a hook-capable tab with an empty composer and no hook → `submit-unconfirmed`, exit 1
- tab gone → exit 4, unchanged

**Why.** A false "confirmed" costs a receiver that sits idle, which cost 15 minutes in R3. A false "unconfirmed" costs one inspect turn. On hook-capable tabs the hook usually lands within the window, so requiring it costs almost nothing. The screen gate closes most of the boot race. The hook requirement catches the rest: a composer that is drawn but drops keys. Option 3 leaves that case to an empty composer that proves nothing.

## Review r1 (Sonnet, BLOCK) and the fixes

| Finding | Fix | Test |
|---|---|---|
| F1 (BLOCK) no evidence read after the last capture | `confirmSubmission` reads the hook evidence after every capture, before it acts on the screen or the deadline. A stale screen therefore earns no extra Enter either. | `send-confirmation.test.ts` "with slow remote captures": a hook inside the last capture, past the deadline |
| F2 one slow capture fails the gate closed | The gate keeps reading until its deadline; a remote screen gate waits at least two of the host's ssh budgets (`remote.timeout-ms.<host>`, else `remote.timeout-ms`, else 5 s; read through vel-D61's `remoteTimeoutMs` since the merge of #56). The proof window scales by budget / 5 s, capped at 60 s for the CLI's 300 s HTTP limit. A capture that answers after the deadline still counts. | `tab-send-readiness.test.ts` "over a slow remote capture"; `cli-tabs-send.test.ts` window per host key |
| F3 acceptance send exits 1 | `checks-effects.cjs` posts the stand-in's `prompt-submit` when the typed line reaches it, while the send waits. No other in-repo caller sends to an agent tab (`checks.cjs` and `checks-wave4.cjs` send to terminal tabs). | acceptance wave 13 |
| F4 typed before the baseline check | The baseline is read before the typing; with none the send answers 409 `submit-unconfirmed`, `typed: false`, and types nothing. The CLI exits 1 and says nothing was typed. | `cli-tabs-send.test.ts`, `cli-exit-codes.test.ts` |
| F5 `maintenance.sh` labels | `maintenance.sh` lives in the library (<repo>). The CLI side pins its labels: 0 sent, 4 gone, 5 and 6 retried, an unproven send exit 1 (`failed:exit-1`, never retried). The library's `test_maintenance.py` fake (rc 0 with `submitted: false`) is a library follow-up. | `cli-exit-codes.test.ts` "match the labels of a caller that retries" |
| F6 another dispatch's hook as proof | `hook-dispatch.ts` only records hooks. Every dispatch takes the tab's send gate before its dispatch lock: `withAgentDispatchLock` (the inbox dispatcher's `attempt`, the automated prompt dispatcher, steer, restart) and the cookie send route. The send proves inside that gate, so no other dispatch types or submits during its window. (r1 proved inside the dispatch lock; CONFIRM r2 below moved the wait to the gate.) No nonce: the Claude hook body the server keeps carries no prompt text. Known limit: a person typing into the pane itself. | `cli-tabs-send-inbox-lock.test.ts`: the real lock, a concurrent inbox submit waits until the send answered |

## CONFIRM r2 (xhigh, CONCERN) and the fix

**Concern.** A live Codex hook is applied inside `withCodexTargetLock` for its tab (`withValidatedCodexHookGeneration`,
`withValidatedLegacyCodexHook`). The r1 F6 fix waited for the proof inside the dispatch lock, which holds that same lock
and the orchestrator tab's. So the `prompt-submit` hook of a local Codex tab could not apply until the window ended,
and every submitted send answered `submit-unconfirmed` and exited 1. A Codex orchestrator's hooks waited out every
send's window in its workspace.

**Fix.** `send-proof-gate.ts` adds a per-tab send gate. `withAgentDispatchLock` takes the target's gate before the
mapping read and the tab locks, and the cookie send route takes it before its target lock. The CLI send uses
`withAgentDispatchThen`: it reads the baseline and types inside the gate and the locks, releases the locks, and waits for
the proof inside the gate only. No hook and no lifecycle step takes the gate, so the Codex hooks of the target and of the
orchestrator apply during the window, and every other dispatch still waits. The order is always gate, then lock.

**Test.** `cli-tabs-send-codex-hook.test.ts` posts the Codex `UserPromptSubmit` hook through the real `dispatchHook`,
`handleCodexHook`, `withValidatedLegacyCodexHook` and `withCodexTargetLock` while the send runs. The send answers
`submitted: true`, and a Codex orchestrator's hook applies before the send answers. With the r2 send route, both tests
fail at the 5 s window.

