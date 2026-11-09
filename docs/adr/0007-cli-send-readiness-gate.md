# ADR-0007: `POST /api/cli/tabs/{id}/send` holds for a bounded readiness window and pastes nothing when it expires

_Epic story: 22 (see `_output/purplemux-mobile/stories/22-cli-send-readiness-gate.md`)._

## Status
Accepted (2026-08-16, epic `purplemux-mobile`, story 22). Narrowed by ADR-0008: the wait described here belongs to the CLI route only — the cookie-authed route sends to a live session in any state.

## Context
 `purplemux tab send` delivers with `sendBracketedPaste` — bracketed paste, then Enter — and answered `{"status":"sent","submitted":true}` unconditionally. An agent TUI that is still booting has no composer bound yet: the paste lands in the input box and the Enter is swallowed. On 2026-08-16 three worker tabs of this epic (stories 06, 07, 09) sat in exactly that state for ~50 minutes of wall-clock. Each call reported success, each tab reported `cliState: busy`, and a tab that never starts never changes state, so no downstream signal existed. Recovery was a manual `tmux send-keys -t <session> Enter`. ADR-0003 already built the gate for the cookie-authed twin (`agent-not-ready`, `detail: 'session-not-running'`), but the CLI route — the one orchestrators drive — had none.

## Options

1. **Refuse immediately when the tab is not sendable**, exactly like the cookie route. Correct but hostile to the dominant caller: an orchestrator that creates a tab and dispatches its brief must now write its own poll loop, and every orchestrator writes a different one.
2. **Paste, then press Enter again (or sleep a fixed interval before pasting).** Converts a deterministic failure into an intermittent one, and a second Enter on an agent that DID accept the turn submits an empty prompt. Rejected.
3. **Hold for a bounded readiness window (`waitMs`, default 60 s, `0` = answer now), re-resolving the tab on every poll, and paste nothing if the window expires.** One readiness definition — `awaitSendReadiness` in `src/lib/tab-send.ts` — serves both routes; the cookie route calls it with `timeoutMs: 0` so the phone still gets an immediate verdict.

## Decision
 Option 3. The gate keys on `cliState` plus `isAgentPanelType`, never on a provider list, so grok-cli (ADR-0005) and any fourth provider are covered by construction. A dead tmux session is checked before the composer gate, so it is diagnosed at once instead of waiting out the deadline. **Nothing is pasted on timeout**: half a brief parked in a composer, waiting for someone else's Enter, is worse than no brief — it is the original failure with extra steps.

## Consequences
 `submitted: true` from either send route now means an agent that could accept a turn was pasted into and the composer came back empty. A `tab send` can block for up to `waitMs` (`--wait-ms N` / `--no-wait` on the CLI); the 409 body names the tab, its `cliState`, and `detail: 'readiness-timeout' | 'session-not-running'`. Terminal, browser and diff tabs are ungated — they have no turn to accept — which also lifts the cookie route's accidental block on sending to a terminal tab.

Source of truth for the epic: `_output/purplemux-mobile/architecture.md` (nomupay workspace).

## Amendment vel-RETRO-R3 (2026-11-09): the screen and the proof
Retro row R3: a brief sent to a fresh tab was typed and not submitted, `tab send` exited 0, and the receiver sat idle
for 15 minutes. A fresh Claude tab turns `idle` on its SessionStart hook, which can fire before the TUI takes keys.
Ruling and options: `docs/design/vel-retro-r3-send-confirm.md`.

1. On the `composer-ready` gate, a tab in `idle`, `ready-for-review` or `busy` waiting at its prompt must also show an
   empty composer on screen (`readComposerScreen`, the screen half of Mission Control's `checkComposerReady`).
   `needs-input` stays status-only. A timeout carries `screen: composer-not-empty | composer-unreadable |
   interactive-prompt-active`, and nothing is typed.
2. After the typing, an agent tab must prove the submission: a turn-starting `prompt-submit` hook after the seq read
   inside the dispatch lock (`lastPromptSubmit`; a Codex tool event does not count), or `busy` from a state that was
   not. The window is 5 s, 10 s for a remote tab, polled every 250 ms. An empty composer is proof only on a tab with no
   prompt-submit hook; a failed capture is never proof.
3. Text still in the composer at 1.5 s gets one more Enter (L37). Option 2's objection does not apply: the Enter goes
   only to a composer that still holds the text, so it never submits an empty prompt.
4. Without proof the answer is HTTP 200 with `submitted: false` and `notSubmitted: typed-not-submitted |
   submit-unconfirmed`, and the CLI exits 1 (ADR-0016): the text was typed, so a resend would type it twice.
5. Review r1 (2026-11-09). The hook evidence is read again after every capture, so a hook that lands while a slow
   remote capture runs is proof, also past the deadline. A remote window scales with the host's `remote.timeout-ms`
   (vel-D61's `remoteTimeoutMs`; at most 60 s), and a remote screen gate waits at least two ssh budgets, so one
   capture that runs the whole budget and fails is never the answer. The send reads its baseline before it types:
   with no status entry it refuses (409 `submit-unconfirmed`, `typed: false`) and types nothing. Every dispatch
   (the inbox and automated dispatchers, steer, restart, both send routes) takes the tab's send gate
   (`send-proof-gate.ts`) before its dispatch lock, so no other dispatch's turn lands in the window. Known limit:
   keys a person types into the pane itself take no gate, and the hook carries no text to tell that turn from the
   send's.
6. CONFIRM r2 (2026-11-09). The send types inside the dispatch lock and waits for its proof outside it, inside the
   send gate only (`withAgentDispatchThen`). A live Codex hook is applied inside `withCodexTargetLock` for its tab,
   and a Codex orchestrator's hooks inside its own: a proof wait under those locks locked out the proof itself, so
   every submitted send to a local Codex tab answered `submit-unconfirmed`. No hook takes the gate. The baseline is
   still read inside the lock, before the typing.
