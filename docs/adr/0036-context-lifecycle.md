# ADR-0036: Context lifecycle — seats rotate from a handoff file

## Status
Accepted (2026-11-03, epic `harness-flow-loop`, story 10; architecture ADR-HFL-04, decision 4 as amended by
HFL-consult-06). Amends ADR-0028 (a third restart actor, `server`) and ADR-0034 (two anomalies,
`seat-compactions` and `rotation-alarm`). Amended 2026-11-08 by vel-D5 (§1 remote seats, §9 the durable
checkpoint, the threshold line in Consequences).

## Context
Long-lived seats average about 540k tokens of context per call; 378 compactions in 14 days, 46 of them the v2
orchestrator's; cache reads are 55% of spend (epic research, high). purplemux saw PreCompact and PostCompact and the
statusline's context, and only the UI read them. Nothing rotated a session. Story 06 rotates each v2 seat once by
hand from a handoff file checked by v2's `tools/handoff-check.py`; this record automates it.

## Options considered
1. Leave compaction on and only measure it.
2. Rotate at a token threshold from a structured handoff file.
3. Rotate on a timer: a quiet seat rotates for nothing, a busy one too late.

## Decision
Option 2.

1. **Seats and the threshold.** A seat is an agent tab created with `tab create --handoff <path>` (absolute; the CLI
   resolves it against its cwd; it need not exist yet). Only seats rotate. The threshold is the tab's
   `--rotate-at <50000..900000>`, else fleet config `context.rotate-at-tokens` (same range, default 300,000; an
   invalid value is the default and is logged), or `--rotate-at off`. The value is orchestrator-writable like the
   flow thresholds: it tunes, it does not admit. A remote tab (`--host`) is a seat too (vel-D5, §9): the path names
   the file on the tab's own host, which the server reads over ssh. The context is the statusline's last request: input + cache writes + cache reads
   (`context_window.current_usage`), matched to the tab by its agent session id. Codex and Grok send no statusline,
   so their seats can rotate only after a compaction, and only when their provider reports a background task
   count.
2. **Rotation** (`src/lib/context-lifecycle.ts`, one instance in the StatusManager). A rotation is due when the context
   reaches the threshold or after a PostCompact. It starts only when `canRotate` holds (architect consult 10-C1,
   option (b) as corrected): the tab is at its prompt (`isAtPrompt`: idle, ready for review, or a stop WAITING with
   no newer event; not halted, not closing or restarting), and a fresh read finds no live registered `tab bg` job
   and no open provider background task. Those die with the restart. Armed watches, probes and leases survive it
   (ADR-0028 §5) and never block: an orchestrator nearly always holds a watch. An unknown task count is not zero:
   a transcript that cannot be read blocks the rotation, and the seat compacts as before.
   The server then routes one event, kind `rotate`, class urgent (ADR-0035), with `whenReady = isAtPrompt`, which
   the router re-checks inside the dispatch lock together with its settle window (no delivery to the tab in the
   last 5 s, story 09 F10; the router gains `ITabEventRoute.whenReady` for urgent events, and a paste refused by
   its own `whenReady` stamps nothing), so it is never typed mid-turn nor into a turn a digest just started:
   `ROTATE: bring <path> up to date, then end your turn with HANDOFF-READY.` A refused ROTATE is tried again after
   3 s, up to 5 times, then at the next idle or 30 s tick. The request time is kept in whole seconds, so a stamp
   written with `date -u -Iseconds` in the same second is not older than it.
   A turn whose last line is `HANDOFF-READY` or starts `HANDOFF-READY:` (read like an end line, emphasis stripped)
   moves the seat to `handoff-ready` (the word as written, alone, followed by `.` or `!`, or starting
   `HANDOFF-READY:`); the check runs at the next point `canRotate` holds. It is not a turn marker:
   it is addressed to the harness, not to the orchestrator. **The file must be current when it is checked**
   (review round 2, F1): any turn that ends without `HANDOFF-READY` while the seat is in `rotate-requested` or
   `handoff-ready`, and any new submission (prompt-submit) while it is in `handoff-ready`, put the seat back to
   `rotate-requested` and ROTATE is asked again at the next idle (within the resend cap below). Each of them also
   moves the request time to that moment (10-N4), so a file written before the seat's last turn fails the stamp
   check whether or not ROTATE is asked again. While the seat is in `rotate-requested`, `handoff-ready` or `rotating`, the
   router holds its digests (`holdDigest`); urgent events still go, and the turn they start sends the seat back as
   above.
   - **Pass:** the seat item is written `rotating` (with the first message and the session before the restart),
     then `restartTab({clear: true, interrupt: false, interruptIf, by: {kind: 'server', reason:
     'context-rotation'}})` (ADR-0028: same tab id; leases, watches, probes, notes, grants and `reportsTo` stay).
     A seat WAITING only on watches is busy to `tab restart` (ADR-0028 §3); `interruptIf` is read **inside the
     restart's dispatch lock** and is true only while the tab's latest event is still that WAITING stop and no
     submission (`orchestrationActivity.turn`) is newer than it, so a turn delivered in between is never killed.
     A restart refused `tab-busy` counts nothing and is retried as above: the stop's own turn acknowledgement
     (`orchestration-activity.ts`) is often still in flight (AC 7 run: stop to restart 28.3 s without the retry,
     3.9 s with it). Any other refusal counts as a failed check, `the restart failed: <code>: <error>`.
     The seat stays `rotating` until the first message `Read <path>, then continue: <resume command>` is typed.
     Meanwhile the router holds its digests and its urgent events too (`holdUrgent`; each recorded undelivered),
     so the fresh session reads its handoff first; when the first message is typed, or dropped, or the restart is
     refused, the held urgent events are typed in order (`releaseHeldUrgent`, every undelivered urgent row since the
     seat entered `rotating` but a ROTATE). An inbox notice (ADR-0012) and a direct `tab send` do not pass through
     the router and are not held. The first message is typed only after a session newer than the restart reported
     in (a session-start hook after the restart, or a bound session id other than the one before it; never the
     pre-restart idle state) and while that agent is idle at its prompt, re-checked inside the dispatch lock. There
     is no fallback timer, so a launch that failed never gets it typed into a shell; after 10 min it is dropped with
     a warning (`firstMessageDropped`) and the seat item carries `handoffUndeliveredAt`, which the board flags
     (`handoff-undelivered`, §6) until a later rotation delivers its first message.
   - **Fail:** one message, `HANDOFF CHECK FAILED: <path>: <reasons>. Fix the file, then end your turn with
     HANDOFF-READY.` (reasons cut at 1,500 characters with a pointer to `purplemux handoff check`), typed under the
     same readiness and settle rules as ROTATE and retried until typed. A second failure sets `rotation-alarm`,
     writes the reasons to the seat item and sends nothing: the session is left as it is. A later `HANDOFF-READY`
     whose check passes still rotates and clears the alarm; nothing else does. Such a `HANDOFF-READY` starts a
     rotation deadline when none is set (the alarm cleared it), so its hold is bounded like any other (confirm P3).
   - **One deadline per rotation** (10-N1): the first ROTATE sets it 30 min ahead and a resend never moves it. A
     rotation asks ROTATE at most twice (the first and one resend). At the deadline, if the seat has not been
     restarted, the digest hold is released, nothing more is sent, and the rotation counts as one failed check
     (`rotationTimedOut`); the next rotation starts no sooner than 30 min later (`nextRotationAt`), so the hold is
     never back-to-back, and the second failed rotation, by deadline or by check, raises the alarm. Failures count
     across rotations until one succeeds. The 60 min stale-digest flag (ADR-0035) names the rotation hold when it
     is the cause.
   - **A server restart mid-rotation** (F3) resumes from the seat item: `rotating` with a restart time, or with a
     bound session other than the one before it, waits for the fresh session and types the first message, its
     10 min first-message timeout running from the resume (confirm P1, P2: a server down longer than that must not
     drop the handoff of a fresh session waiting at its prompt, and an unknown restart time is still bounded);
     `rotating` with neither (the restart never ran) checks the file again. `handoff-ready` whose bound session is
     not the one that said HANDOFF-READY was restarted: it is `rotating`, its first message read again from the
     file, and its 10 min first-message timeout runs from the resume (10-N2); with the same session it goes back
     to `rotate-requested` and ROTATE is asked again. The rotation's deadline and cool-down are read back too.
   Every step for one tab runs in turn, so two idles never send two ROTATEs.
3. **Compaction.** PreCompact adds one to `compactions` and `compactionsSinceRotation` on the seat item. After
   PostCompact the rotation is due at the next idle, whatever the context. Whether a PreCompact hook can block a
   compaction is still not verified; nothing here depends on it.
4. **Handoff schema and checker.** `checkHandoff(text, now, rotateRequestedAt)` in `src/lib/handoff-check.ts`, pure
   and browser-safe, returns `{ok, reasons, seat, updatedAt, resumeCommand}`. Its rules and its reason wording are
   v2's `tools/lib/handoffcheck.py` (story 06), including the choices decision 4 does not state: the title
   `# Handoff: <seat> · updated <UTC>` first; the seven headings once each, in order, no other, `#` headings and
   fenced code honoured; 12,288 bytes; Role 1-3 lines; In flight `none` or the 4-column table; Open questions
   `none` or Mission Control item ids; Standing rules `none` or `- <rule> (source: <one source>)` with the source
   `SO-<n>`, `DEC-<n>`, `ARC-<n>`, `lane ledger <name> <YYYY-MM-DDTHH:MM:SSZ>` (name
   `[A-Za-z0-9][A-Za-z0-9_-]{0,31}`) or `owner message <UTC date>`; Resume command one line; the stamp not older than
   the request and at most 5 min after now. `KR-<n>`, `C-<name>`, an `ORCH-<n> <UTC>` without `lane ledger`, a
   ledger stamp without seconds or with a non-digit minute, a bad ledger name and two sources on one rule are
   refused. To give one verdict per file the port copies Python's character classes (`str.isspace`,
   `str.splitlines`, Unicode `\d` in `DEC|ARC|SO-<n>`), `repr` escaping in the header refusal, and Python 3.14's
   reading of `24:00` as the next midnight. A UTF-8 BOM is kept by both readers (`TextDecoder` with `ignoreBOM`), so
   a file that starts with one is refused (no title line) as v2 refuses it (F6). `POST /api/cli/handoff/check` runs
   it for `purplemux handoff check <path>`; the CLI reads the file (an unreadable or non-UTF-8 file is a refusal,
   exit 1) and prints v2's lines.
8. **What the acceptance check proves** (F8). The isolated-instance check (`scripts/acceptance/checks-context-lifecycle.cjs`,
   wave 10) runs a stand-in agent, not Claude: the stand-in draws a composer, records what is typed, and the check
   posts the hooks and the statusline reading Claude would. It proves the server's wiring end to end (ROTATE at
   the prompt, the check, `restart --clear` under the same id, the first message into the fresh session, the seat
   item). Claude's own side (that a real seat writes the file and ends with HANDOFF-READY, and reads the file after
   the restart) is proven at the first live seat rotation (v2 story 06's rotations), which the orchestrator
   observes.
5. **Seat item** (ADR-0033 type `seat`, server-written). Key `seat:<ws>:<tab-name>`, holder the tab name. `open` at
   create or at the first reading after a server start (event id per tab, so a restart does not reopen it; a server
   start writes the resumed phase as a `state` event); `state` = the phase (`watching`, `rotate-requested`,
   `handoff-ready`, `rotating`, `rotation-alarm`); `clear` carries a
   reading or a compaction with no state change (a seat has no wait, so `clear` changes only attrs and the last
   event); `close` when the tab closes. Attrs: `tabId`, `handoffPath`, `rotateAtTokens`, `contextTokens`,
   `contextAt`, `compactions`, `compactionsSinceRotation`, `lastCompactAt`, `rotations`, `lastRotationAt`,
   `rotateRequestedAt`, `readySessionId`, `rotationFailures`, `rotationAlarm`, `firstMessage`, `sessionBefore`,
   `restartedAt`. A changed reading is recorded at most every 5 min. A reading belongs to its session: a
   session-start (a human `/clear`, a launch) drops it, and so does a bound session other than the reading's (F5).
   After a server restart the counts, an open request and an alarm are read back from the open item. A seat item
   that cannot be written is logged and never stops a rotation: it is telemetry. The checkpoint of §9 is not.
6. **Board.** Three anomalies per open seat (ADR-0034 amended): `seat-compactions` (`compactionsSinceRotation`,
   threshold 0: a compaction is a missed rotation), `rotation-alarm` (`rotationFailures`, threshold 1) and
   `handoff-undelivered` (1 while `handoffUndeliveredAt` is set, threshold 0: "rotated but the handoff was not
   delivered"). Each breach is a ledger flag alert (ADR-0032) to the workspace's orchestrator until story 13 routes
   it.
7. **Paths** (convention, not enforced): v2 `.v2/seats/<seat>/handoff.md`; other workspaces
   `~/.purplemux/workspaces/<ws>/seats/<tab-name>/handoff.md`.

9. **Durable checkpoint (vel-D5, `docs/design/vel-d5-durable-rotation.md`).** A passing check is not enough to
   clear a session. The server probes git on the tab's host (worktree, branch, head, base ref and merge base, dirty
   count) and writes a checkpoint to `rotation_checkpoints` in `ledger.sqlite`. The checkpoint holds those facts and
   the handoff's own fields (resume command, in-flight rows, open decision ids, `Do not`, standing-rule sources,
   decisions, the whole text). The key is `seat:<ws>:<tab-name>#<attempt>`, never a session or an account. The
   server reads the row back and compares the digests. Only an equal read-back lets `restart --clear` run. A write
   or a read-back that fails stops the rotation in `handoff-ready`, with `checkpointRefused` on the seat item, an
   error in the log and the refusal in the stale-digest flag, and the rotation deadline bounds it. A remote host that
   does not answer is the same wait, never a failed check. The row only moves forward (`written`, `cleared`,
   `delivering`, `delivered`; or `abandoned`, `undelivered`, `delivery-unknown`). A server start reads it before the
   seat item: a row the clear reached resumes `rotating`, and a row stopped in `delivering` is frozen, never typed
   twice, and flagged `handoff-undelivered`. At resume the server probes git again and writes the handoff (when it
   is missing or differs) and `<handoff>.checkpoint.json` on the tab's host. The first message then adds a RESTORE
   NOTICE. A match keeps the line `Read <path>, then continue: <resume command>` first. A mismatch lists each
   difference and asks for reconciliation before the resume command. Both say what the checkpoint does not restore.
   The fleet view (`rotation`) reports the covered workers, the rotations, the refusals and the wait-to-rotate time.
   Its totals include closed seats. A counter that no seat item wrote is `null`, which means not measured.
   `checkpointRefusals` counts one per rotation attempt that stopped before the clear, not one per refusal event.
   One attempt may hit a store failure, then a host down at the restart, then retries; it counts once. A clear, a
   timeout or a failed check ends the attempt. The seat item's `checkpointRefused` names only the current cause of
   the stop, and it is cleared as soon as that cause is gone.
   Review round 1 adds these rules:
   - A row is live only for its own tab id. Closing a tab abandons its unfinished rows.
   - A `written` or `cleared` row that has not moved for 40 min is finished, never resumed. The 40 min is the 30
     min deadline plus the 10 min first-message wait.
   - A `written` row whose checkpoint has no session is frozen as `delivery-unknown`.
   - A restart that cannot reach the remote host or its kit before it kills anything is a wait.
   - A remote seat's host comes from the seat, else from its layout, and never defaults to this host.
   - Retention deletes finished rows after 92 days, but never a task's newest row.

## Consequences
- A seat restarts at its threshold, 300,000 tokens by default (amended by vel-D5: this line said 50-100k, which
  the code never did), instead of compacting at 967k; its standing rules live in a file a
  checker reads, not in a compaction summary.
- The rotation adds one urgent wake (ROTATE) per rotation and, on a failed check, one more.
- A seat's first rotation after deploy needs its tab created with `--handoff`: existing tabs carry no handoff path.
- v2's `tools/handoff-check.py` can retire: `purplemux handoff check` gives the same verdict (story 10 record:
  3,027 texts, 3,027 identical reason lists, the BOM cases included).

## What proves it wrong
For 3 days after a seat's first automatic rotation, the owner's corrections to that seat per day rise against the 3
days before, or a rule in the pre-rotation list is missing after it (story 06's diff): the handoff loses state, and
the schema gains the missing section before the next rotation. A seat whose `seat-compactions` stays above 0 for a
day while its context passes the threshold means `canRotate` never holds for it (always busy, or always holding
background work): measure how long it was idle and either rotate on a waiting stop or lower its threshold.
