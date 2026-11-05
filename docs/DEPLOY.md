# Deploying purplemux on the live host

`scripts/deploy-live.sh` is the only deploy path. `orchestration/deploy.sh` is superseded. The decision record is [ADR-0017](adr/0017-deploys-through-releases-quiet-wait-and-rollback.md).

## Layout

| Path | Holds |
|---|---|
| `~/.purplemux/releases/<sha12>/` | a detached worktree of `~/code/purplemux`, built |
| `~/.purplemux/releases/current` | symlink to the running release |
| `~/.purplemux/releases/previous` | symlink to the rollback target |
| `~/.purplemux/releases/first-install-rollback/` | the drop-in and CLI link target from before the first release install |
| `~/.purplemux/backups/<stamp>-<sha12>/` | `*.json` stores and `mission-control.sqlite`, newest 5 |
| `~/.purplemux/hook-spool/` | hook events no server answered, replayed by the next server ([ADR-0020](adr/0020-hook-spool-across-restarts.md)) |
| `~/.purplemux/logs/deploy-live-<stamp>-<sha12>.log` | build output |
| `~/.config/systemd/user/purplemux.service.d/50-mission-control.conf` | runs `releases/current` after the first install |
| `~/.local/bin/purplemux` | symlink to `releases/current/bin/purplemux.js` |

## Run a deploy

The run takes longer than the 10-minute foreground limit of an agent's shell tool. Start it with the host's background mechanism (Claude Code: `run_in_background`) and read the summary when it exits.

```bash
~/code/purplemux/.worktrees/<worktree>/scripts/deploy-live.sh <git-ref>
```

Options:

| Option | Effect |
|---|---|
| `--dry-run` | build, run the acceptance gate, render the release's hook scripts into a scratch directory and report the quiet state; no backup, no hook install, no swap, no restart |
| `--quiet-timeout SECONDS` | bound of the quiet wait (default 900) |
| `--force-after-timeout` | deploy even if tabs are still mid-turn at the timeout |
| `--ignore-tab WS/TAB` | exclude one more tab from the quiet wait (repeatable) |
| `--outside-tab` | the shell runs outside every purplemux tab, so there is no own tab to exclude |
| `--rollback` | swap `current` and `previous`, restart, health-check |
| `--announce MINUTES` | before the quiet wait, `deploy announce` (1-60 min) to every enabled orchestrator and tab-bound lease holder, then wait until each notice is delivered or held, at most MINUTES (story 13) |

A tab is mid-turn for the quiet wait when it is busy and its last event is not `stop` (story 38's working predicate). A WAITING tab (busy only on its own background work after a stop, ADR-0018) is quiet: it prints `WAITING <ws> <tab> <name> waiting-for=… (quiet: background job)` and is counted in `QUIET=` (`quiet (1 WAITING)`). A tab list without `lastEvent` counts every busy tab as mid-turn. `busy-for=` counts from the current prompt, not from a `busySince` that spans earlier WAITING turns. The tab in `PMUX_TAB_ID` is always excluded from the quiet wait. A tab created before story 01 has no `PMUX_TAB_ID`; the script then refuses with `REFUSED OWN-TAB-UNKNOWN` until you name your own tab with `--ignore-tab <ws>/<tab>` (or pass `--outside-tab` from a plain shell).

### Announce

`--announce N` runs `purplemux deploy announce --in N --reason "deploy <sha>" --except-tab <own tab>` with the admin token, after the deploy lease and before the quiet wait. Each orchestrator and each tab holding a tab-bound lease (merge, dev-deploy, epic, …) receives one fixed inbox line with the restart time and `purplemux deploy status <id>`; the reason is only shown by that command. The script polls `deploy status` every poll interval until every notice is delivered, held, dropped or pruned, or N minutes pass, then prints `ANNOUNCE_ID=` and later `ANNOUNCED=<delivered>/<recipients>`. The tab running the script is left out: it is mid-turn until the restart. A running server that predates the command (`routes-absent`) does not stop the deploy (`ANNOUNCED=unavailable …`); any other failure refuses with exit 1 before anything restarts. Every `--ignore-tab` is left out of the announce as well. Before the restart (or, on a refusal or an interrupt, at the end) the script runs `deploy withdraw <id>`, so a notice still waiting never tells a tab about a restart that is over (`ANNOUNCED=1/3; 2 still waiting, withdrawn`). If the script dies before it can, the inbox drops each deploy notice 30 min after its restart time rather than type it. The deploy lease's TTL covers the announce wait too.

## Exit codes

| Exit | Meaning | Live service |
|---|---|---|
| 0 | deployed, rolled back on demand, or dry run | new release (or unchanged on dry run) |
| 1 | lease probe or acquire failed, announce failed, backup failed, hook pre-install failed, tmux sessions unreadable | unchanged (the hook scripts may already be the release's; they work with the old server) |
| 2 | refused: usage, ref, disk, build, acceptance, hook installer missing or dry-run render failed, own tab unknown, drop-in drift or rewrite, half-finished first install, rollback target missing or unbuilt | unchanged |
| 3 | quiet timeout, deploy lease held, another deploy running | unchanged |
| 4 | restart, `daemon-reload` or health gate failed; the previous release was restored (`VERDICT=rolled-back`); the automatic rollback failed too (`VERDICT=rollback-failed`, read `ROLLBACK_HEALTH=` and the journal); or an on-demand rollback failed its gate (`VERDICT=rollback-unhealthy`) | previous release, or check by hand on `rollback-failed` / `rollback-unhealthy` |

The last lines are one summary block: `RELEASE=`, `PREVIOUS=`, `SESSIONS=kept/before`, `HEALTH=`, `ROLLBACK_HEALTH=` (after a rollback), `QUIET=`, `LEASE=`, `BACKUP=`, `ACCEPTANCE=`, `ANNOUNCED=<delivered>/<recipients>` (`-` without `--announce`; `unavailable (…)` against a server that predates it), `HOOKS=` (`pre-installed 4 scripts (N changed) from …`, `dry run: the release rendered …`, or `skipped (…)` on a rollback to a release without the installer), `INTERRUPTED=` (when a signal arrived in the swap window), `VERDICT=`.

## Acceptance gate

After the build and before the lease, the quiet wait, the backup or any switch, the script runs the
release's OWN `scripts/acceptance/run.sh --candidate <release>`. A failure, or a release without the
harness, refuses with exit 2 (`ACCEPTANCE-FAILED` / `ACCEPTANCE-MISSING`); the live service is
untouched. `--rollback` skips it: the target already ran live. `DEPLOY_BASH_GUARD=<bash-guard.py>`
adds the engineering guard check and makes it required. The log is
`~/.purplemux/logs/acceptance-<stamp>-<sha12>.log`.

The gate starts the release as a second server that shares nothing with the live one:
`HOME=/tmp/pmxa.XXXXXX/home` (so `~/.purplemux` is throwaway), `TMUX_TMPDIR=/tmp/pmxa.XXXXXX/tmux`
(its own `tmux -L purple` socket), `HOST=localhost` on a spare port >= 18000, and `env -i` with a
short whitelist, because a shell inside a live tab carries `PMUX_TOKEN`, `TMUX` and the live
`__PMUX_PRISTINE_ENV`, which the candidate would hand to its own tabs. It refuses before starting
when the scratch HOME or socket would resolve to the live ones, when the socket path exceeds the unix
limit, or when the port is the live one or answers. After the start it reads the candidate
processes' environ and refuses (`NOT-ISOLATED`) if any live key (`PMUX_TOKEN`, `PMUX_TAB_TOKEN`,
`TMUX`, …) or a pristine env with another HOME got through. The state file is written as soon as the
server starts, and any failure or signal after that tears the instance down; further signals are
ignored while the teardown runs. Teardown scans `/proc`
and stops every process whose environ carries the scratch HOME (by process group when the group
leader is one of them) and never signals any other process; tmux is killed only through the scratch
socket. The gate runs without deploy-live's lock descriptor, so a leftover could never hold the lock.

The checks (`scripts/acceptance/checks.cjs`) run the release's installed entry point `bin/purplemux.js`,
and each prints `PASS`/`FAIL` with what it measured and expected:

| Check | Proves |
|---|---|
| `fixture-cap` | first, before any other check (`checks-wip-cap.cjs`). It writes nothing unless the state is provably the scratch instance: neither its HOME nor its `.purplemux` resolves (realpath) to the live one, and its `.purplemux/port` names the state's port and not the live port. Then the scratch fleet's `tabs.cap-per-workspace` is set to 200, the key's maximum, and read back from both workspaces through `tab count` (`capSource: fleet-config`). The fixtures stay open across checks and outgrow the default 8, so a failed set or read-back runs no other check. Only the scratch HOME is written; the live fleet keeps its own cap |
| `wip-cap-refusal` | SC-2 (ADR-0027): with one probe agent tab in workspace A, the cap is lowered to A's count, and an agent tab create exits 3 `wip-cap` naming the count and the cap and makes no tab; the cap is restored and read back, and the probe closed. A cap that is not restored (`fixture-cap-restore`) runs no later check. These gate results alone never pass a run; `--only-wave` takes an integer from 1 to the number of waves only |
| `tab-create`, `tab-list`, `tab-send-result`, `tab-status` | tab create/list/send/result/status in two workspaces |
| `identity-env` | a tab carries `PMUX_TAB_ID` and `PMUX_TAB_TOKEN` (ADR-0010) |
| `legacy-tab-identity` | a tab without `PMUX_TAB_TOKEN` (every tab created before story 01) still takes a lease, as an unverified holder named by its session |
| `lease-race`, `lease-verified` | two tabs race one merge lease: one wins, one gets exit 3 naming the holder, the holder is verified |
| `lease-renew-release`, `lease-expiry` | renew and release by the holder only; a 2 s lease expires (ADR-0011) |
| `epic-ownership`, `num-claim` | an epic claim frees when its tab closes; a number claim survives its tab until `release-epic` |
| `exit-4-target-gone`, `exit-2-usage`, `exit-7-not-found`, `exit-6-unreachable`, `exit-6-routes-absent` | the CLI exit-code contract (ADR-0016) |
| `bash-guard` | with `--bash-guard`: the guard allows the holder's merge and refuses another tab's |
| `turn-marker`, `turn-waiting`, `turn-ready` | ADR-0018 with a scratch `claude` stand-in and posted hook events: a marker line reaches the orchestrator nudge; a stop with a live `tab bg` job stays busy with no nudge; a plain stop keeps READY FOR REVIEW |
| `live-socket-untouched` | no isolated session appeared on the live tmux socket |

Run it by hand against any built checkout:
`scripts/acceptance/run.sh --candidate <dir> [--log FILE] [--bash-guard PATH] [--keep]`.

## Hook scripts before the restart

From the stop to the new server's start no server answers a hook, and the old scripts dropped
every event of that window: a turn that ended then left its tab `busy` and its orchestrator
unnudged. After the quiet wait and the backup, and before the swap, the script runs the release's
own `scripts/install-hook-scripts.sh --dir ~/.purplemux`. It renders `status-hook.sh`,
`statusline.sh`, `codex-hook.sh` and `grok-hook.sh` from the release's templates and replaces each
in one rename. Those scripts post the same headers, URL and body, now on stdin (a Claude post-tool
body over the 128 KiB argument limit now reaches the server; the parser reads only paths and the
command), so the old server keeps answering them until it stops. When no server answers, they write
the event to `~/.purplemux/hook-spool/`, and the new server replays the spool in time order once it
listens and on every poll (ADR-0020). A POST that the exiting server cuts (curl 52/56) is lost, not
spooled: that server may have applied it and persists no floor, so a replay could repeat it.

- A forward deploy of a release without the installer refuses before the lease: `HOOK-INSTALL-MISSING`, exit 2.
- A failed pre-install refuses before the swap: `HOOK-PREINSTALL-FAILED`, exit 1.
- `--dry-run` runs the installer into a scratch directory and reports it in `HOOKS=`; `~/.purplemux` is untouched. A render failure refuses (`HOOK-RENDER-FAILED`).
- `--rollback` runs the target release's installer when it has one; otherwise `HOOKS=skipped (…)`, and the target's server writes its own scripts when it starts. A target that is not a release (a first install's live checkout) runs no installer: `HOOKS=skipped (rollback target is not a release)`.
- After a healthy rollback restart (automatic or `--rollback`) into a target that is not a release directory with the installer, the script moves `hook-spool/*.json` into `hook-spool/bad/rollback-<stamp>/` and appends `N spooled event(s) set aside in …` to `HOOKS=`. Such a server never drains the spool and saves no hook floor, so a later server could not order those files against the events it applied live. A first install's live checkout always counts as such a server: its working tree need not match the build it runs. `hook-spool/.floors.json` stays.
- When the rollback fails its own health gate, the spool stays and `HOOKS=` ends `rollback-unhealthy; spool kept`: the next server that comes up drains it against its own floor.
- A forward deploy whose running server does not drain the spool (a release without the installer, or a first install's live checkout) moves any `hook-spool/*.json` already there into `hook-spool/bad/stale-<stamp>/` before it installs the new scripts, and appends `N stale spooled event(s) set aside in …` to `HOOKS=`. Those files are leftovers of that server (for example after an unhealthy rollback whose old release came up later), which applied events live and saved no floor. A dry run moves nothing.
- `DEPLOY_HOOK_INSTALL` overrides the installer path (tests).

Check the spool after a deploy: `ls ~/.purplemux/hook-spool/` is empty once the new server has
polled; `hook-spool/bad/` holds any file that could not be replayed, and the `hook-spool` log group
names each one.

## Health gate

Within 90 s after the restart, all of these must hold:

1. `systemctl --user restart` exited 0.
2. The service has a new `MainPID`, and `/proc/<pid>/cwd` resolves to the release directory. `/api/health` answers the same for every release, so this check is what proves the new code runs.
3. `GET /api/health` answers `app: purplemux`.
4. Every tmux session name recorded before the restart still exists. New sessions are allowed.
5. A workspace-token `purplemux tab list` answers. With no workspace token on the host the check is reported as skipped (`HEALTH=pass (tab-list skipped: no workspace token)`).

From the first link change until the gate or the rollback ends, the script defers INT and TERM. A `SIGKILL` in that window can still leave the links swapped; run `--rollback` or check `releases/current` by hand. A run that received a deferred signal still reports its verdict, but it skips the release rotation (`ROTATION=skipped …`).

## The first install

The first run finds no `releases/current`. It then:

1. links `releases/previous` to the directory the drop-in runs today (`.worktrees/mission-control-human-escalation` on 2026-09-26);
2. saves the drop-in and the `~/.local/bin/purplemux` target to `releases/first-install-rollback/`;
3. rewrites the drop-in to `releases/current` and prints the diff;
4. runs `systemctl --user daemon-reload` before the restart.

The first wave-1 deploy runs against the b428f4d1 server: `LEASE=unavailable (server predates leases)` is expected, and the quiet wait reads each agent tab's status route because that tab list has no `cliState`.

## Roll back

- Automatic: a failed health gate restores the links from before the run and exits 4. The summary and the journal lines show why.
- On demand: `scripts/deploy-live.sh --rollback` from `releases/current/scripts/`. Right after a first install it restores the saved drop-in and CLI link and removes `current` and `previous`. It continues past a broken lease route or lease CLI (`LEASE=unavailable (…; rollback proceeds)`); only a live `deploy:purplemux` holder elsewhere stops it.
- A rollback swaps code only and never restores a backup. Restore a backup by hand only with the service stopped.
- **bash-guard coupling.** Rolling back to a build without leases while the engineering bash-guard lease rules are live makes every merge fail closed. Set `MERGE_LEASE_OK=1` for the orchestrator (fleet-wide if needed) or revert the engineering change until a lease-capable release runs again.

## Old releases

Each successful deploy keeps `current` and `previous` and removes other release worktrees under `releases/` by exact path (`git worktree remove`). A directory under `releases/` that is not a worktree of the primary repository is reported as `PRUNE-SKIPPED` and left alone. The live worktree that `previous` names after a first install is outside `releases/` and is never removed.

## Testing

`tests/unit/scripts/deploy-live.test.ts` runs the script against fake `systemctl`, `pnpm`, `curl`, `tmux`, `purplemux`, `journalctl`, acceptance and hook-installer binaries (`DEPLOY_*` overrides), a temporary `HOME` and a real git repository. It never reaches the live service.
