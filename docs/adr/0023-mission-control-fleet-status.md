# ADR-0023: Mission Control fleet status — one read model for stalls

## Status
Accepted (2026-10-16). Brief: `_output/scrum-master/purplemux/brief-fleet-stall-status.md` (nomupay workspace). Attribution ruling: architect consult 01, same folder.

## Context
On 2026-10-16 one workspace ran 18 worker tabs. A brief stayed unsubmitted in the composers of two new tabs for 2.5 h, and a worker's question stayed in its tab output for about 3 h. The owner saw it first; the Scrum Master did not. The facts were already on the server: the StatusManager holds each tab's `cliState`, `lastEvent`, `busySince`, `readyForReviewAt` and the watchdog's `turnEnd` (ADR-0018); the watch, liveness and lease stores hold each tab's registered waits; Mission Control holds the SM-inbox candidates. No screen joined them per tab with a time.

## Decision
1. **One read model, server-derived.** `src/lib/fleet-status-snapshot.ts` gathers the facts per agent tab of every workspace, and the pure `src/lib/fleet-status.ts` derives one row: state, time in state, registered waits, the last end line (`turnEnd.marker`, verbatim), SM-inbox items, and flags. The view is a new `fleet` section of `GET /api/mission-control/coordination` (human session only), so it rides the panel's existing 15 s poll. The server computes it at most once per 5 s, however many viewers poll.
2. **States.** `working` (busy mid-turn), `waiting` (busy on a stop that ADR-0018 classified `waiting` and that is still the latest event), `needs-input`, `ended` (the latest stop carried an end line), `ready-for-review` (stopped without an end line), `idle`, `unsubmitted` (text in the composer of a tab at its prompt), `inactive`, `unknown` (shown as a neutral word, with the served value in a tooltip).
3. **Flags**, sorted to the top, with fleet config (ADR-0019) thresholds in minutes, in (0, 10080]:

   | Flag | Rule | Key | Default |
   |---|---|---|---|
   | STALL? | working or waiting, and the watchdog sent its `stuck` nudge with no activity since it (the nudge latch is once per busy stretch, so a recovered tab is not stalled) | `fleet-status.stall-minutes` | — |
   | STALL? | working, and the newest of `lastEvent` and the transcript mtime is N min old (no transcript stamp: the watchdog verdict only) | same | 30 |
   | STALL? | idle or ready-for-review with no end line, no live registered job and no armed watch, for N min; never when the end line is unknown after a restart | same | 30 |
   | STALL? | needs-input for N min, or the agent not running for N min since the server saw it stop (not after an end line other than `BLOCKED:` / `NEEDS-DECISION:`: that agent finished) | same | 30 |
   | STALL? | composer text for C min | `fleet-status.composer-minutes` | 2 |
   | WAITING-LONG | waiting for M min | `fleet-status.waiting-long-minutes` | 120 |
   | UNANSWERED | an open SM-inbox item with no `humanReview`, K min old | `fleet-status.unanswered-minutes` | 30 |
   | UNANSWERED | the tab is still stopped on a `BLOCKED:` or `NEEDS-DECISION:` end line, K min after it (no prompt since, so no reply) | same | 30 |

   An unreadable store raises no flag on a guess: an unknown job or watch list is not "no registered wait", and an unknown SM inbox is shown as "—", never 0.
4. **End lines survive a restart.** The watchdog persisted only markerless stops (`watchdogTurnEnd`, ADR-0018 L49), so after a restart every tab that ended on a line read as "no end line". An end-line stop is now persisted too and restored to a tab that comes back `ready-for-review`, or `idle` after a dismiss newer than the stop, in the same agent session (an idle tab not dismissed since was prompted and interrupted, so its line is stale). It fires nothing: the idle nudge reads only a markerless record, and the marker nudge only a new stop. A tab restored at its prompt with no record has no latest event; the panel reads its end line as unknown and raises no flag on it.
5. **Composer time.** The text arrived at the last automated submission (`orchestrationActivity.turn.at`) when that came after the tab's last hook event: it was typed and never taken. Otherwise the time is the first poll that saw the text, kept on `globalThis` and cleared when the composer empties. A server restart restarts that clock. Only local tabs at their prompt are captured (`capturePaneContent`, escapes kept so a dim suggestion reads as empty): idle, stopped, or WAITING on their own work at the prompt (ADR-0018 A′), where the inbox and `tab send` still type. A tab mid-turn or a remote pane is never read.
6. **Who posted an SM-inbox item.** The events route resolves the caller (ADR-0010) and records the opener of each new `attention.opened` in `mission_item_openers`, an unversioned side table in `mission-control.sqlite` (the `portfolio-store` precedent), written with `INSERT OR IGNORE` inside the `applyEvents` transaction. `SCHEMA_VERSION` stays 4, so a release rolled back onto the file still opens it; there is no foreign key an older writer could trip. The opener comes from the credential (`launch` verified; `hook` and `session` asserted), never from the payload. It is advisory: no authorization reads it, and the wire snapshot and event feed do not carry it. An item with no row, or whose opener tab is gone, shows on its workspace's "unattributed" line, so nothing is hidden.

## What the panel never does
It never sends input to a tab, never resizes or attaches a pane, never nudges, and never writes to a tab, a lease, a watch, the inbox or Mission Control. Its one pane access is a capture of a local tab at its prompt. The one write on its path belongs to the shared layout reader: a layout file that does not parse is copied aside to `.json.bak`, as for every other reader of it.

## Options rejected
- A schema-5 column for the opener: atomic, but a rollback to a schema-4 release refuses the database and all of Mission Control fails.
- Matching item ids or story ids to tab names: names diverge, and the contract forbids producer claims of identity.
- A second poller or a new route: the coordination poll already runs while Mission Control is visible.

## Consequences
The Scrum Master and the owner see a stall as a flag with its time, not as an absence they must notice. Items posted before this change, or from a tab without a token, read as unattributed. The composer clock is a lower bound after a restart. Codex and Grok report no background tasks (ADR-0018), so their waits list only registered jobs and watches.
