# ADR-0019: Fleet config — versioned values that tools read at call time

## Status
Proposed (2026-09-26). Epic `purplemux-portfolio-coordination`. Story 24 builds the store, routes and CLI; story 25 (skills) makes `gate.sh` read `gate.slots`.

## Context
On 2026-09-26 the orchestrator changed one number, the gate slot cap, from 4 to 6. It sent `tab steer --no-interrupt` to 14 busy workers. Each worker spent a paid turn to acknowledge the message, and 14 nudges came back (learning L16). The value is one that tools read when they run. Nobody had to act on it, so nobody had to be told.

## Options
1. Keep the broadcast, but send it through the inbox (ADR-0012). Each worker still spends one turn.
2. Put the value in `~/.purplemux/config.json`. That file holds the UI settings and the auth secrets (`authPassword`, `authSecret`), and the settings UI writes it.
3. A separate store, `~/.purplemux/fleet-config.json`: versioned string values with a change history and an audit line. Any scope reads it. The admin token or a workspace's enabled orchestrator tab writes it. A change sends no message to anyone.

## Decision
Option 3.
- Store: `{ values: { <key>: { value, version, setAt, setBy } }, versions: { <key>: n }, history: [last 200] }`, file mode 0600, one process lock, tmp + rename. A malformed file is refused (`config-store-unreadable`), never read as empty.
- Keys match `^[a-z][A-Za-z0-9._-]{1,63}$` (widened 2026-11-03 by ADR-0039 so a key can end in a workspace id). A value is one line of text of at most 256 characters, without control or format characters; the reader parses it.
- Versions count per key and never repeat: an unset raises the version too, and `versions` remembers it, so an `--expect-version` taken before an unset cannot match after a new set. Setting the value a key already holds is not a change.
- Routes: `GET /api/cli/fleet-config[?key=|?history=1[&key=]]` (any valid scope); `PUT` and `DELETE /api/cli/fleet-config/<key>` with an optional `expectedVersion`.
- Authority: the admin token, or the tab that is its workspace's enabled `orchestratorTabId` — the rule of the deploy lease. This is cooperative, not a security boundary (C-312 class): every agent can read the admin token.
- Codes (ADR-0016): `config-invalid` 400 (exit 2), `forbidden` 403 (exit 3), `config-version-conflict` 409 (exit 3), `config-not-found` 404 (exit 7). A malformed store answers 500 `config-store-unreadable` on every fleet-config route; ADR-0027 maps it to exit 3, so `config get/set/list/unset/history` exit 3 (was 1, unmapped) on a malformed store.
- CLI: `config get KEY` prints the bare value (exit 7 and nothing on stdout when unset), `config list [--json]`, `config set KEY VALUE [--expect-version N]`, `config unset KEY [--expect-version N]`, `config history [KEY] [--json]`.
- Every change appends one line to `~/.purplemux/audit/coordination.jsonl` (`fleet-config-set` / `fleet-config-unset`, key, old and new value, version, setter). No broadcast, no nudge, no inbox notice.
- Tools read with an explicit precedence and log the source they used. For `gate.sh`: `--slots` > `$GATE_HOST_SLOTS` > `gate.slots` > 3.

## Consequences
- Briefs stop spelling tunables. The worker contract's gate line drops `GATE_HOST_SLOTS=` once story 25 ships.
- A worker tab cannot change a fleet value.
- Broadcasts stay for what a worker must act on.
