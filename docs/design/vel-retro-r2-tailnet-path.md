# vel-RETRO-R2: pool admission measures the tailnet path

## Problem
Retro 2026-11-09 row R2: the new exec hosts reached control-host only through a DERP relay for hours (RTT about 1 s, ssh
18-25 s), and no tool noticed. The orchestrator measured both exec hosts DERP-relayed (`sin`), RTT 0.85-1.17 s. Measured again from
`host-a` at 2026-11-09 05:13Z: `tailscale ping -c 1 control-host` printed
`pong from control-host (2001:db8::1) via DERP(syd) in 147ms` and `direct connection not established` (exit 1);
`tailscale status --json` showed the peer `Relay: "syd"`, `CurAddr: ""`.

The owner keeps the hosts. The pool must not refuse a host for its path; it reports the path.

## Sources read (SO-1)
- `docs/adr/0039-pool-scheduler.md` (read model §1, placement §3, board §7, amendment vel-D4), `docs/adr/0022-remote-tabs-tmux-over-ssh.md`
  (ssh options §5), `docs/adr/0032-flag-alerts.md` (raise edge, baseline, repeat, target).
- `src/lib/pool-read.ts` (`PoolReader`, `POOL_READ_SCRIPT`, the 30 s poller), `src/lib/pool-service.ts`
  (`readPoolView`, `readPoolWouldRefuse`), `src/lib/pool.ts`, `src/types/pool.ts`, `src/lib/remote-host.ts`,
  `src/lib/fleet-status-snapshot.ts`, `src/types/fleet-status.ts`,
  `src/components/features/mission-control/fleet-status-panel.tsx`, `src/lib/flag-alerts.ts`,
  `src/lib/scrum-master-access.ts`, `src/lib/portfolio-store.ts`.
- Tests: `tests/unit/lib/pool-read.test.ts`, `tests/unit/lib/pool-service.test.ts`, `tests/unit/lib/pool.test.ts`,
  `tests/unit/lib/fleet-status-snapshot.test.ts`, the flag-alert tests.

## Measurement (decided by the docs; no consult)
- The path is measured from this host (the purplemux server), where `tailscale` runs. It is a local exec, not an ssh
  read, so it never waits on the host it measures and never runs under the lease lock (ADR-0039 §2).
- After each pool read (30 s) of a remote host, the reader measures the path to the alias that answered, else the
  host's own (`measureTailnetPath`):
  1. `ssh -G -- <alias>` gives the address ssh dials (its `hostname` line).
  2. A literal IP is used as is; a name goes through `dns.lookup(name, { all: true })` (the hosts file, then DNS,
     MagicDNS included).
  3. No address in the tailnet ranges (the RFC 6598 shared address space and fd7a:115c:a1e0::/48): `kind: 'not-tailnet'` (a LAN alias such
     as `host-b-lan`), with nothing to report.
  4. A tailnet address gets one `tailscale ping -c 1 --timeout 2s <ip>`. The first `pong from` line decides:
     `via DERP(<region>)` or `via peer-relay(...)` is `relayed`; `via <ip>:<port>` (IPv6 in brackets) is `direct`;
     any other `via` token is `unknown` with the reason `unrecognised path "via <token>"`, never `direct` (review r1
     M2).
  The code does not read `tailscale status --json`; an earlier draft of this section said it would.
- A relayed path is `relayed` (with its region). A path whose RTT is at or above `pool.path.slow-ms` (fleet config,
  default 250, 1..60000) is `slow`. A measurement with no `pong from` line is `unknown`, never `direct`. A non-zero exit alone is not a failure: `tailscale ping` exits 1 with "direct connection not established" after a DERP pong, which is the retro case.
- A measurement stands for its alias for 5 minutes (`TAILNET_PATH_TTL_MS`, review r1 L6). An `unknown` measurement, or
  a `relayed` one not yet confirmed, is taken again at the next read. A measurement turns `unknown` in the view once it
  is older than the TTL plus the read staleness (90 s).
- A relayed path raises `tailnet-relayed` only on its second relayed measurement in a row (`relayedReads`, review r1
  L3): a ping to an idle peer can pong through DERP before the direct path is set up. A direct or off-tailnet
  measurement resets the count; an `unknown` one leaves it as it was.
- The path is served on each host of `IPoolView` (`path`) and on the fleet view, and placement reads none of it.

## Consult
**Question.** Where does the one alert for a relayed or slow host path go, and when does it fire again?

Facts:
- The flag tick (ADR-0032) gives the raise edge, the first-tick baseline, the repeat window
  (`alerts.flag-repeat-minutes`) and delivery through the tab event router. Every flag carries a `workspaceId`; its
  target is the flagged tab, or the workspace's enabled orchestrator.
- A host is fleet-wide: no workspace owns it. The portfolio store holds the Scrum Master selection
  (`managerWorkspaceId`, `managerTabId`); SO-10 sends every owner-facing message through that seat.
- `bg-host-unreachable` (liveness manager) nudges the tab that owns the job; a path has no job.

Options:
1. **A pool flag in the flag tick, to the Scrum Master seat.** Source `pool`, rules `tailnet-relayed` and
   `tailnet-slow`, subject the host. The flag's workspace is the portfolio manager workspace and its tab the manager
   tab. With no selection, the flag stays on the fleet panel and the tick logs `flag-alert-no-target`.
2. **As 1, but to every workspace orchestrator with an agent tab on that host.** The seats that feel the slowness hear
   of it. One relayed host can then send N alerts.
3. **A push to the owner's devices** (notification dispatcher, a new tab-less kind). Skips SO-10's seat.

**Ruling** (one `claude -p --model claude-opus-5-5 --effort xhigh` consult, 2026-11-09):

RULING: **Option 1, changed in three ways.** The flag key does not include the manager workspace. Delivery is a tab line only. A host raises one rule at a time.

- **Source and rules.** `source: 'pool'`; add `'pool'` to `TAlertFlagSource`. Rules are `tailnet-relayed` and `tailnet-slow`, and the subject is the host. Each host raises at most one rule per tick, and `relayed` wins over `slow`. The key is `pool:fleet:tailnet-path:<host>` (`poolFlagKey`), one per host whatever the rule (amended by review r1 L4; the consult answered `pool:fleet:<rule>:<host>`), so the workspace part is the fixed `fleet`. A key that included the manager workspace would change on every Scrum Master reselection, which would clear and re-raise every standing path flag outside the repeat window.
- **Read sources.** `pool:<host>` is both the raise source and the clear source. It counts as read when that host's path is `relayed`, `slow`, `direct` or `not-tailnet`. It counts as failed when the path is `unknown` or the cached pool read is older than `POOL_READ_STALE_MS` (90 s). The flag tick reads the cached pool view and never measures. `pruneFlagSources` drops `pool:<host>` for a host that a good pool view no longer lists. The per-source baseline in §4 does not hold back a pool flag (amended by review r1 M1; the consult kept it): a host already relayed at its first read alerts once, inside the repeat window.
- **Target, resolved at send time.** It comes from `getPortfolioStore().currentSelection()`.
  - No selection: not sent, reason `no-scrum-master`.
  - Otherwise, call `flagAlertTarget({...flag, workspaceId: managerWorkspaceId, tabId: null}, managerWorkspace, view)`. If the orchestrator that comes back is not `managerTabId`, the reason is `scrum-master-not-current`.
  - Every no-target case logs `flag-alert-no-target` and leaves the flag on the fleet panel and the pool view, as §5 does.
  - The cases §5 treats as unknown stay pending and are retried with `flag-alert-target-unknown`.
- **Delivery.** `routeTabEvent` to that tab, with kind `flag`, `classifyWake('flag', {severity: 'warn'})` (a digest line) and `rule` set. The text is `<host> tailnet path relayed via DERP(<region>), RTT <n> ms` or `<host> tailnet path slow: RTT <n> ms (threshold <slow-ms>)`. Nothing is dispatched to the phone, because under SO-10 the Scrum Master decides what reaches the owner. A line the router accepts marks the flag alerted. A refusal calls `deferFlagRaise`.
- **Repeat.** As §3: the flag alerts when it is raised, and a re-raise inside `alerts.flag-repeat-minutes` sends nothing. A standing flag does not repeat; the board shows it. This keeps a flapping DERP/direct path to one line per window per host, whatever the rule (amended by review r1 L4; the consult said per rule and host).
- **Rejected.** Option 2 sends N copies of one fact and goes around SO-10's single seat. Option 3 skips the seat altogether.
- **Docs.** Record this as an ADR-0032 amendment for §5, source `pool`.

**Measurement defect: yes.** "A failed measurement is `unknown`" must mean "no `pong from` line", not a non-zero exit. The Problem section's own evidence, `pong … via DERP(syd) in 147ms`, came back with exit 1 ("direct connection not established"). Reading exit 1 as a failure would turn exactly the retro case into `unknown`, and that path would never alert.

## Review r1 (Sonnet, PASS-WITH-NITS; LOGIC: CONCERN) and the changes

| Finding | Change |
|---|---|
| M1 a host relayed at its first read never alerts | A pool flag carries `alertAtFirstRead`: it alerts on its first good read too, inside the repeat window. A restart and a host added while relayed (the retro case) each alert once. Every other flag keeps the §4 baseline. |
| M2 an odd `via` token reads as direct | `direct` only for an `ip:port` endpoint; anything else is `unknown` with its reason. |
| L3 a cold ping can pong through DERP | `tailnet-relayed` needs two relayed measurements in a row; the reader retakes an unconfirmed relayed one at the next read. |
| L4 one alert per rule and host | The key is `pool:fleet:tailnet-path:<host>` (`poolFlagKey`), so a host alerts once per window whatever the rule; a raised flag that changes rule is the same raise. This changes the ruling's key `pool:fleet:<rule>:<host>`. |
| L5 the doc did not match the code | The Measurement section above names `ssh -G`, the lookup and the ping. |
| L6 a ping on every read | One measurement per alias per 5 minutes, still taken after the host read. |
