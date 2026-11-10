# ADR-0032: Flag alerts — one alert when a fleet or flow flag is raised

## Status
Proposed (2026-10-26, epic `purplemux-flow`, story 10). Amends ADR-0002 (alert kinds and the orchestrator-only policy).

## Context
Fleet flags (ADR-0023: STALL?, WAITING-LONG, UNANSWERED) and flow flags (ADR-0026) exist only when a viewer polls Mission
Control. A stall nobody looks at stays silent. The dispatcher (`src/lib/notification-dispatcher.ts`) applies no policy;
its callers apply `shouldAlert` (orchestrator-only by default, `src/lib/status-manager.ts:1339,1454`), and so do the web
hooks (`src/hooks/use-toast-notification.ts:43`, `use-native-notification.ts:46`). `IAlert.tabId` is a required string,
and the phone reads it as the tab to open.

## Options considered
1. **Alert from each poll.** No tick; but no poll means no alert, which is the defect.
2. **Inbox notices to orchestrators.** Reaches agents only, types into a composer, and is not for the human.
3. **A server tick with raise-edge state, one new alert kind, and an explicit policy exemption.**

## Decision
Option 3.

1. **Kind.** `TAlertKind` gains `'flag'`. `IAlert` gains the optional `flag?: {source: 'fleet' | 'flow', rule: string,
   subject: string, text: string}`. `notification:alert` frames are otherwise unchanged; old clients drop the unknown
   kind (the phone) or ignore it (the web, verified in `use-agent-status.ts`).
2. **Tick.** One 60 s interval per process (`globalThis.__ptFlagAlertTick`, started beside the Mission Control runtime,
   stopped in `shutdownWs`). Each tick reads `readFleetView(now)` (the 5 s cache) and `deriveFlowFlags` over every
   workspace's flow record. A tick that runs longer than 5 s logs its duration; the next tick is skipped while one runs.
3. **Raise edge.** The key is `source:workspaceId:rule:subject`. State on `globalThis.__ptFlagAlertState`:
   `{raisedAt, lastAlertAt}` per key. A key present now and absent in the previous tick is a raise. A raise sends one
   alert unless the key alerted within fleet config `alerts.flag-repeat-minutes` (default 60, 1..10080). A flag that
   stays raised sends nothing more.
4. **Baseline.** The first tick after a process start records the raised keys and sends nothing, so a deploy does not
   replay every standing flag. The baseline is per source (the fleet view, each workspace's layout, each tab's state,
   the SM inbox, the registered waits, each workspace's flow record): a key first seen in a source with no good read
   since the start, or since the switch came back on, is recorded and not raised, whatever the tick count.
5. **Target.** A fleet flag names the flagged tab. A workspace-level fleet flag (an unattributed UNANSWERED) and every
   flow flag name the workspace's enabled orchestrator tab. With no orchestrator the alert is not sent; the tick logs
   `flag-alert-no-target` and the flag stays on the panel. The same holds for a disabled orchestrator and for an
   `orchestratorTabId` whose tab a readable layout no longer shows. When the tick cannot check the target (the fleet
   view or the workspace's layout is unreadable, or the orchestrator's row is in state `unknown`), the raise stays
   pending: it is retried on each tick while the flag stays raised, and the tick logs `flag-alert-target-unknown`.
   `isOrchestrator` is true only when the named tab is the orchestrator.
6. **What raises nothing.** An unreadable store or flow record raises no flag on a guess (ADR-0023 rule), and clears
   none: a flag its source cannot speak for this tick is unknown. A stale flow raises only its `stale` flag
   (ADR-0026 §5).
7. **Switch.** Fleet config `alerts.flags`: `off` stops every flag alert; any other value, or unset, is on. The
   `alerts.*` keys are written by the admin token only (`ADMIN_ONLY_KEYS`, ADR-0027 §1): they decide what reaches the
   owner's phone.
8. **Policy.** The tick calls `NotificationDispatcher.dispatch` directly. The orchestrator-only predicate
   (`alertsOrchestratorOnly`) does not apply to kind `flag`: a flag is a fleet-level fact the owner asked to see, and the
   alert names the orchestrator wherever the flag is workspace-level. The web client shows a `flag` alert as a toast
   with the flag text and a link to Mission Control, outside any orchestrator filter: `showNotificationAlert` in
   `src/hooks/use-agent-status.ts`, the one web consumer of `notification:alert` frames. The hooks
   `use-toast-notification.ts` and `use-native-notification.ts` never read alert frames and keep their filter for
   every other kind. Electron shows the same in-page toast for `flag` and no OS notification, by design. Every other
   kind keeps its policy.

## Consequences
- The owner and the phone learn of a stall or a bottleneck within about a minute of the flag, without watching.
- A server restart loses the raise-edge memory on purpose; the baseline rule prevents an alert storm.
- The tick adds one fleet-view read per minute (pane captures of tabs at their prompt); the 5 s cache shares it with any
  open panel.
- Some fleet stamps are in memory (ADR-0023), so a deploy can still raise a fleet flag once. The composer clock restarts
  at boot, so a STALL? for unsubmitted composer text can alert once after a deploy. A tab restored `inactive` after a
  restart has no observed stop time, so it may not raise "agent not running".

## Amendment (2026-11-03, epic `harness-flow-loop`, story 13: alarm routing; architecture ADR-HFL-03 decisions 1 and 5)

Section 5 is amended for source `ledger`; fleet and flow flags keep it unchanged. Sections 3 and 4 gain one rule for
item alarms (consult ruling 13).

1. **Ledger flags.** Source `ledger` carries two kinds: the finder's breached anomalies (ADR-0034 §8; rule the
   anomaly id) and, new, every open wait past its threshold (rule the counted reason, subject the item key). A
   threshold is fleet config `ledger.threshold.<reason>`, minutes in 0..10080 or `off`; the defaults are
   ADR-HFL-03's: `red-main` 0, `chain-down` 10, `not-armed` 20, `group-partner` 30, `agent-idle` 30, `land-queue` 60
   (its derived `land-queue/*` split too), `own-lane-order` 60, `owner` 120. A reason with no threshold raises no
   alarm until one is set; the derived `unknown` takes none (the `unknown-share` anomaly covers it).
2. **Target (§5 for source `ledger`).** A ledger flag names its routed tab: fleet config `ledger.route.<ws>`, groups
   `<target>[+<target>]=<pattern>[,<pattern>]` joined by `;`. A target is a tab name or id, `$holder` (the item's
   holder; an anomaly's subject seat), `$orchestrator`, or `$board` (recorded, typed into no tab). A pattern is a wait
   reason, a derived reason, an anomaly id, or a prefix ending in `*`; the exact reason wins, then its producer
   reason, then the longest prefix. A reason the table does not name, and a holder or tab name that names no tab of
   a readable layout, go to the workspace's enabled orchestrator. A table that does not parse is refused at write
   time (`config-invalid`) and, if one is found at read time, routes the workspace to the orchestrator with one log
   line. With no orchestrator and no other routed tab, nothing is sent and `flag-alert-no-target` is logged. **An
   unknown target stays pending as before:** an unreadable fleet view or layout, or a routed row in state `unknown`,
   defers the raise to the next tick (`flag-alert-target-unknown`). So does a fleet config the tick cannot read: with
   no route table and no thresholds known, every `ledger:<ws>` source is unread that tick, so ledger flags neither
   raise, repeat nor clear, and a configured `off` is never overridden by a default. Both `ledger.*` keys have
   ADR-0019's writers (the admin token or an enabled orchestrator) and are checked at write time; a route key names a
   workspace (`ledger.route.<workspaceId>`, never an empty suffix).

   **The v2 default table** (`V2_DEFAULT_ROUTE`, 238 characters; ADR-HFL-03 decision 1 amended by consult 13):
   `not-armed`, `own-lane-order`, `review-findings`, `rework` and `agent-idle` go to `$holder`; `land-queue/*`,
   `lock-wait`, `under-lock-gate`, `pre-flight-gate`, `gate-slot`, `host-load` and `chain-down` to `v2-kit`;
   `red-main` to `$holder` (the arming tab of the last landed range, v2 note n-YQMUaheJdq) and the orchestrator;
   `owner` to the board only; `group-partner` and `deploy-*` to the orchestrator. group-partner goes to the
   orchestrator by name: its clear needs a `.v2/train-groups` edit or a stop of another lane's unit, and its holder
   (`keyed-group`) names no seat. The holder is a tab id or name: a lane id such as `E2` names no tab and falls back to
   the orchestrator until the v2 producers send the arming tab id (story 02).
3. **Delivery.** A ledger flag reaches its tabs through the tab event router (ADR-0035), never typed directly. An item
   alarm is a tab line only, kind `alarm`: urgent (`block`) for `red-main` and a critical-path `chain-down`, a digest
   line (`warn`) otherwise; the line reads `<item> <reason> for <age> (threshold <n> min); clear: <clear input>`, and
   a tab that is not the holder also reads `; holder <holder>`. It never reaches the phone. An anomaly keeps its §8
   alert, now naming its first routed tab, and that tab gets one digest line, kind `flag`; as before this amendment,
   only a sent phone alert marks the anomaly alerted. An item alarm raise that reaches no routed tab (the router
   refused every line) stays pending and is retried on the next tick.
4. **The held-copy guard, raise and repeat (item alarms only).** §3's edge and window are unchanged. On a raise of a
   digest line, a routed tab whose digest still holds a copy of the same item and reason gets no second line; the copy
   counts as the alert there (review r1, R2). An urgent raise is typed whatever the tab's digest holds. It never waits
   in a digest, so it cannot stack there, and a held line of an earlier episode cannot stand in for it (confirmation
   N2). While an item alarm stands, and only while every source it rests on read well this tick (a repeat is a
   re-raise, §6), the tick routes it again to each routed tab once `alerts.flag-repeat-minutes` have passed since the
   later of the last copy to that tab (with none: the later of the key's last alert and the tick that recorded it,
   read once per tick before that tick's sends) and that copy's delivery, and never while a copy of the same item and
   reason still waits in that tab's digest. The guard reads `tab_events` (`TabEventsTable.copies`, the text's fixed
   opening `<item> <reason> for `, matched in SQLite characters, 7 days back), so it holds across a restart. An
   unreadable log sends the raise anyway (delivery never waits on a ledger read, ADR-0035 §4) and skips the repeat. A
   repeat is always a digest line. Under §4's baseline, after a restart or after `alerts.flags` comes back on, a
   standing alarm is recorded without a word. Its first repeat comes one window after that tick. A repeat counts as an
   alert for §3's window, so a new episode of the same item inside one window of a repeat is not raised again, and its
   next line is the digest repeat; red main is keyed per blocked range, so a new red main also raises urgent lines on
   the other blocked ranges (confirmation N2, residual). An anomaly flag stays edge-only.

Why (consult ruling 13): edge-only never says a missed line again, and an item that crossed its threshold while the
server was down would never be alarmed at all. The guard keeps a busy or dead holder to one held line per item; the
router's held-tab report (ADR-0035 §3) tells the human after an hour.

## Amendment vel-RETRO-R2 (2026-11-09): pool path flags, §5 source `pool`
Consult ruling: the vel-RETRO-R2 design check (an internal record). ADR-0039 amendment vel-RETRO-R2 measures the path.

1. **Source and rules.** `TAlertFlagSource` gains `pool`. The rules are `tailnet-relayed` and `tailnet-slow`, and the
   subject is the host. A host raises at most one rule per tick, and `relayed` wins. The key is
   `pool:fleet:tailnet-path:<host>`, one per host whatever the rule (review r1 L4): the fixed `fleet` keeps a Scrum
   Master reselection from re-raising a standing flag, and a path that flaps between the rules alerts once per window.
2. **Read sources.** `pool` is the fleet view's `poolPaths` (failed when absent, or when the view names a `pool paths`
   error, which fails nothing else). `pool:<host>` is read for a `relayed`, `direct` or `not-tailnet` path and failed
   for an `unknown` or unmeasured one. The tick reads the cached view and never measures. A host the pool no longer
   lists loses its source while `pool` reads well. **The §4 baseline does not hold back a pool flag** (review r1 M1):
   a host already relayed at its first read (a restart, a host added while relayed: the retro case) alerts once,
   inside the repeat window. Every other source keeps the baseline.
3. **Target.** Resolved at send time from the portfolio Scrum Master selection: the manager workspace's enabled
   orchestrator, which must be the selected manager tab. No selection: `no-scrum-master`. Another tab:
   `scrum-master-not-current`. Both are no-target cases (§5): logged, and the flag stays on the fleet panel. An
   unreadable selection, and §5's unknown cases, are retried on the next tick.
4. **Delivery.** One digest line through the tab event router (kind `flag`, `rule` set), and no phone alert: under
   SO-10 the Scrum Master decides what reaches the owner. A line the router refuses is retried on the next tick.
5. **Repeat.** As §3: a re-raise inside `alerts.flag-repeat-minutes` sends nothing, and a standing flag does not repeat.
