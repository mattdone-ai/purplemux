# Test fixtures

## `grok-session/`, `grok-session-tools/`

Two real **Grok Build 1.0.4** sessions recorded on 2026-08-16, copied out of
`~/.grok/sessions/<url-encoded cwd>/<session-id>/`. They are the contract
`src/lib/session-parser-grok.ts` is written against — the ACP update schema is
not documented line by line, so the recording is the specification.

| Fixture | Recorded with | Covers |
|---|---|---|
| `grok-session/` | `grok -p "Reply with exactly the word OK…" --output-format json` | `user_message_chunk`, `agent_thought_chunk`, `agent_message_chunk`, `turn_completed` usage and cost |
| `grok-session-tools/` | a headless turn that edits a file and runs a shell command, `--always-approve` | the above plus `tool_call` and both flavours of `tool_call_update` — the non-terminal one that refines a call's title, and the terminal one that carries `status` and `rawOutput` |

Copied per session: `updates.jsonl`, `summary.json`, `signals.json`,
`events.jsonl`, `rewind_points.jsonl`.

Deliberately **not** copied: `chat_history.jsonl` (the raw model messages,
including encrypted reasoning blobs — nothing reads it), `prompt_context.json`
and `system_prompt.txt` (loaded instructions), and the `.lock` siblings.

`costUsdTicks` in `turn_completed` is USD × 10^10. That scale is not documented;
it was fixed by a headless run that printed both `total_cost_usd 0.01009732` and
`total_cost_usd_ticks 100973200`.

## `claude-background/`, `turn-errors/`

Shapes of real Claude Code 2.1.283 and Codex transcripts on this host (2026-09-26), cut to the entries a
parser reads and sanitised (no prompts, secrets or paths beyond what the parser keys on).

| Fixture | Source | Covers |
|---|---|---|
| `claude-background/shapes-2.1.283.jsonl` + `agent-*.jsonl` | ws-fOvEfz worker transcripts | background shell / timeout-moved shell / async agent / Monitor starts, `SendMessage` resume, `TaskStop`, `<task-notification>` as queue-operation, `queued_command` attachment and user message, Monitor events and expiry (story 15) |
| `turn-errors/claude-server-error-2.1.283.jsonl` | W4 (tab-ySeykz) 2026-09-26 01:30Z, entry verbatim minus usage fields | `isApiErrorMessage` + `error: server_error` (story 26) |
| `turn-errors/claude-authentication-failed.jsonl` | 2026-08-25 session, entry verbatim minus usage fields | `error: authentication_failed` |
| `turn-errors/claude-usage-warning-footer-negative.jsonl` | the 05:49–05:53Z footer as captured by an orchestrator and quoted by it | NEGATIVE: the usage WARNING is never an error |
| `turn-errors/codex-*.jsonl` | `~/.codex/sessions` `task_complete` events (401 key redacted) | `codex_error_info` usage_limit_exceeded / server_overloaded / other |

Not recorded anywhere on this host, so not fixtured and not classified: a Claude usage-limit HALT, and any
Grok error (named gaps, ADR-0018 story-26 amendment).

## `owner-issues/`

`owner-issues.yaml` is a synthetic file in the shape of treasury-v2's `.v2/owner-issues.yaml` (story 35; no owner
text copied). `tests/unit/lib/owner-found-defects.test.ts` turns it into the ledger events the v2 feed sends after the
kit fix of consult Q2 (`open` at the file's mtime, `attrs.raisedAt` = 00:00 `Australia/Sydney` of the `raised` date) and
pins that the finder counts by the raised time, not by when the feed first saw the row.
