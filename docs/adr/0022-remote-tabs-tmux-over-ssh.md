# ADR-0022: Remote tabs — one control plane, tmux over ssh

## Status
Accepted (2026-10-10) for slice (a): terminal tabs. Slices (b) agent tabs and (c) the host badge are designed here and not built.

## Context
On 2026-10-10 the host that runs purplemux (mdserver1) had 91 GiB of RAM, 69–78 GiB used, 2 GiB free and swap full (7/7 GiB), with about 6 orchestrators and 20 worker tabs. A second host, ai-server, had 373 GiB, 203 GiB available, and 64 cores. The owner asked for worker tabs that run on ai-server and appear in the mdserver1 workspace like local tabs: create, send, status, result and close, in the web UI and the phone app, and visible to the watchdog, Mission Control and notes.

Every tab today is one tmux session `pt-<ws>-<pane>-<tab>` on the local socket `purple`. Every tmux call goes through `src/lib/tmux.ts` with the session name, and `terminal-server.ts` attaches the browser with `tmux attach` under node-pty. Agent state comes from hooks that POST to `localhost:<port>` with the global CLI token (ADR-0020), and from local process and transcript reads.

## Options
1. **Federate two purplemux servers.** ai-server already runs its own purplemux (socket `purple`, port 8022, its own token). mdserver1 would proxy every tab route to it. Rejected: layouts, leases, the inbox, notes, the watchdog and Mission Control all assume that one server owns a tab. Each route would need a proxy, tab identities and tokens would cross servers, and ADR-0017 already rejected two servers over one set of tabs.
2. **Nested tmux.** A local session whose pane runs `ssh -tt ai-server tmux attach`. All local tmux calls work unchanged. Rejected: the local pane process is `ssh`, so process detection, cwd, scrollback and capture describe the ssh client, not the remote pane. A dropped connection leaves a local shell, and the next `tab send` runs its brief on mdserver1.
3. **One control plane; a tab has a host; tmux runs over ssh.** Chosen.

## Decision
1. **Registry.** Fleet config key `remote.hosts` (ADR-0019; the admin token or an orchestrator sets it) holds a comma-separated list of ssh aliases. Unset means no remote hosts. A name matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`, so it is never an ssh option.
2. **Tab attribute.** `ITab.host` is persisted in the layout. Absent means local. `tab create --host H` (CLI) and `host` (POST `/api/cli/tabs`) set it once; a tab never changes host. The tab list and `tab status` serve `host` (additive, ADR-0004). A host not in the registry is refused with `remote-host-invalid` (400, exit 2).
3. **Routing.** The session name stays `pt-<ws>-<pane>-<tab>`. `src/lib/session-host.ts` maps a session name to its host. It reads the session's workspace layout once and caches the answer on `globalThis`. A new remote session is registered before its tmux session exists. Every function in `tmux.ts` asks this map, and a remote call runs `ssh <host> tmux -L <socket> …` with the same tmux arguments. Local calls are unchanged.
4. **Remote socket and config.** The remote socket is `pmux-<origin hostname>`, never `purple`: the remote purplemux owns `purple`, and its scans must not see these sessions. Each create writes the local `tmux.conf` to `$HOME/.purplemux-remote/<origin>/tmux.conf` on the remote and starts the session with `-f` on that file.
5. **ssh.** `BatchMode=yes`, `ConnectTimeout=5`, `ControlMaster=auto`, `ControlPersist=10m`, `ServerAliveInterval=15`, and `--` before the host. The control socket is `~/.purplemux/ssh/%C`. A socket path longer than 100 bytes (the kernel limit is 108; measured below) turns multiplexing off for that process. Every call has the existing 5 s tmux timeout.
6. **No pid crosses a host.** A remote pane pid is never returned to local code: `getSessionPanePid` answers null, `getAllPanesInfo` reports `pid: 0` with `host`, `getPaneDetailInfo` reports `pid: null`, and `observeSessionStrict` answers `unknown` for a present remote session. So no `/proc` read, `process.kill`, port scan or provider process check runs on a pid of another host. A remote tab therefore cannot be designated orchestrator: designation needs a strict local process proof (ADR-0021).
7. **No remote path is read as local.** `getSessionCwd` keeps its contract, a local directory, and answers null for a remote session. The git, diff, file-content and session-list routes already treat null as "no directory". `git/sync` would otherwise run `fetch`, `pull` and `push` in the mdserver1 checkout that has the same path. `crossCheckLayout` never recreates a remote session locally, and remote tabs do not add their cwd to the workspace directories.
8. **Create.** The pane shell starts as `env -i … "$SHELL" -l` with the remote's own `HOME`, `USER`, `SHELL`, `LANG` and `XDG_RUNTIME_DIR`, plus `PMUX_TAB_ID` and `PMUX_WORKSPACE_ID` (the ADR-0016 reap marker). It gets no tokens, no `CLAUDE_CONFIG_DIR` and no `GROK_HOME`: those name mdserver1 paths and secrets. The cwd is the workspace directory; tmux starts a missing directory in the remote `HOME` (measured). An ssh failure (exit 255) refuses with `remote-host-unreachable` (503, exit 6) and removes the half-created session.
9. **Close and reap.** A remote close runs one shell script on the remote (`sh -s`). It finds the pane's descendants and every process of the user whose environment holds exactly `PMUX_TAB_ID=<tab>`, then sends SIGTERM to the pane's process group and to those processes, kills the session, waits up to 3 s, sends SIGKILL to survivors, and reports each process as `killed` or `survivor`. The result is `reaper: 'remote'`, with the same audit entry as ADR-0016. `--keep-processes` signals the pane group only.
10. **Attach.** The browser and phone attach through node-pty to `ssh -tt <host> tmux -u -L <socket> attach-session -t <name>`. The WebSocket protocol is unchanged.
11. **Status.** The poll merges `list-panes -a` from each registered host into the pane map. A remote terminal tab reports `idle` when its foreground process is a shell and `running` otherwise; listening ports are not read.
12. **Refused in slice (a).** `tab create --host` with an agent type, and a web UI switch of a remote tab to an agent type, refuse with `remote-type-unsupported` (400 / 409, exit 2). The message names this ADR. A person can still run an agent by hand in a remote terminal tab; purplemux then shows a terminal.

## Feasibility, measured 2026-10-10 from mdserver1
- `ssh -o BatchMode=yes ai-server` works without a prompt. ai-server: Linux 7.0.0-34, uid 1000 `mdone`, `HOME=/home/mdone`, tmux 3.6 (mdserver1 also 3.6), Claude Code 2.1.295 (mdserver1 2.1.296).
- ssh round trip: about 70 ms without multiplexing, 50–60 ms multiplexed. A ControlPersist master started from Node `execFile` did not hold the call open. A control path in the session scratch directory was refused: `ControlPath too long (… >= 108 bytes)`.
- On a throwaway socket: `new-session -c /nonexistent/dir` exits 0 and the pane starts in `/home/mdone`; `send-keys` and `capture-pane` round-trip; `has-session -t =nope` exits 1 with `can't find session: nope`; after `kill-server`, `ls` exits 1 with `no server running on …`. ssh's own failure is exit 255, so the two are distinguishable.
- `kill-server` left a `( sleep 300 & )` and a `setsid sleep 301` of the pane alive; `grep -lzx PMUX_TAB_ID=<tab> /proc/[0-9]*/environ` found both among 1 863 processes in 56 ms.
- `claude` started in a throwaway remote session in `/tmp` and drew its composer within 10 s ("Claude Code v2.1.295 … Opus 5.5 (1M context)"); the session and every marked process were then removed.
- ai-server reaches `http://mdserver1:8022/api/health` and `http://100.94.44.114:8022/api/health` (200). mdserver1 listens on `0.0.0.0:8022` with `networkAccess: tailscale`, so a hook from ai-server passes the address filter.
- ai-server has its own `/home/mdone/code/nomupay` (separate clones; `treasury-api` on `main`, `engineering` on another branch), its own `gh` login (`mattdone-ai` active), AWS profiles and Claude credentials. No path is shared or mounted. `sshfs` exists on mdserver1, not on ai-server.

## Hard problems
| Problem | Slice (a) | Plan |
|---|---|---|
| tmux calls for a remote tab | solved: routed by session name | — |
| Terminal attach (web, phone) | solved: `ssh -tt … attach` | — |
| `tab result`, `tab send`, `tab status` | solved: capture-pane, send-keys and list-panes over ssh | — |
| Close: processes that escape the pane | solved: remote marker scan (§9) | — |
| A remote pid read as a local pid | solved: never returned (§6) | (b) adds a remote process proof |
| A remote cwd read as a local path | solved: null (§7) | (c) may show it as text |
| Agent state hooks | refused | (b): the remote hook script POSTs to `remote.callback-url` (Tailscale) with a token the server writes to `$HOME/.purplemux-remote/<origin>/` (0600). No spool replay: the server cannot drain a remote spool, so an event lost in a restart is rebuilt by `resolveUnknown`, which needs the transcript. |
| Transcripts (timeline, ADR-0018 end lines, background ledger) | refused | (b): the server reads them over ssh, or mounts the remote claude-home with sshfs (inotify does not see writes made on another host, so the watch falls back to polling). Unmeasured. |
| `purplemux` CLI inside a remote tab | refused: no token is sent; the remote CLI reads its own `~/.purplemux/port` and reaches the remote's own server, which refuses or knows no such tab | (b): a `PMUX_URL` override in `bin/cli.js` and a tab token; needs the remote host's purplemux release to carry it |
| Claude, gh and AWS credentials on the remote | not copied: each host uses its own login. AWS SSO expiry on ai-server is the ai-server login's problem | — |
| Worktrees and repo paths | not shared: a remote worker clones or creates its own worktree on the remote | — |
| MCP config | not copied: the remote's own `~/.claude` and `.mcp.json` apply | (b) names it per workspace |
| Host down | the poll and attach treat a remote session as absent; status reads time out at 5 s; no local session is ever created in its place | — |

## What would disprove it
- A tmux call for a remote tab that reaches the local `purple` socket, or a local session created for a remote tab (§3, §7).
- A local process signalled, or a local `/proc` entry read, because of a remote tab (§6).
- A close that leaves a marked process alive on the remote and still reports no survivor (§9).
- Per-call ssh latency high enough that `tab send` to a remote tab misses its Enter where a local send does not; the measured 50–60 ms is below the 600 ms gap of the two-Enter submit.

## Consequences
- RAM moves off mdserver1 only for work that runs in remote tabs; the tmux client and the ssh attach stay local (one ssh process per open terminal view).
- The server must hold a working non-interactive ssh login to every registered host. A host whose key or alias breaks shows its tabs as not running until it is fixed.
- A registered host costs one `list-panes` over ssh per status poll.
- Version skew between the two hosts (Claude Code 2.1.296 here, 2.1.295 there) is visible only inside the remote tab.
