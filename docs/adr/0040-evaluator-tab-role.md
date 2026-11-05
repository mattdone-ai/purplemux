# ADR-0040: The evaluator tab role

## Status
Accepted (2026-11-03, epic `harness-flow-loop`, story 18; architecture ADR-HFL-07 decision 1, audit H7). The Bash rule
set below is the ruling of the story's architect consult. Review round 2 amended it: the built-in set is closed with
`--tools`, credential paths are denied, and the browser is held to one preview origin.

## Context
The reviewer reads diffs with Read, Grep and Glob only. The owner found 62 defects after gate and receipt in 14 days, and
11 "done" claims failed on the preview (harness-flow-loop research). The evaluator seat (story 25, `/v2-evaluate`) has to
drive the preview the way the owner does and read state, and it must not be able to change the repository it judges.
The purplemux browser endpoints need Electron and have no click; the chrome-devtools MCP with
`~/.local/bin/headless-chrome` works headless today.

Measured on claude 2.1.317 against a scripted Messages API:
- `--disallowedTools Edit,Write,NotebookEdit` removes the three tools even under `--dangerously-skip-permissions`; a
  forced `Write` returns `No such tool available: Write. Write is disabled for this session, in subagents as well as
  here.`
- Under bypass permissions an allow rule restricts nothing. Under `--permission-mode dontAsk`, a prefix allow rule
  denies `touch`, redirects and compound commands, but lets the allowed program's own flags through:
  `curl -s URL -o f` wrote `f`.
- mdserver1 has no `bwrap`, so Claude Code's Bash sandbox cannot run here.
- Under dontAsk without `--tools` the session kept 21 built-ins; `EnterWorktree` created a branch and a worktree in the
  repository (review round 2). With `--tools Read,Grep,Glob,Bash` the init tool list is those four plus the MCP tools,
  and every other built-in answers `No such tool available`.
- An unscoped Read reached `~/.purplemux/cli-token`. A `Read(<path>)` deny rule refuses Read, Grep, Glob and the
  read-only Bash commands (`cat`, `ls`) on that path.
- dontAsk lets Claude Code's own read-only Bash commands run without a rule: `cat`, `head`, `ls`, `wc`, `pwd`,
  `git status` and `git log` ran inside the repository. Their write flags (`git log --output`, `sort -o`,
  `find -fprint`), `git branch`, `git stash`, `git config`, `env` and `curl` were denied.
- chrome-devtools-mcp honours `--allowedUrlPattern` from Chrome 149. mdserver1 had 147.0.7727.15; story 18 installed
  chrome-headless-shell 156.0.8078.4 beside it (`evidence/18/host-chrome-156.log`).
- chrome-devtools-mcp 1.12.0 lets its file tools write under its `--workspace`, under every root the client sends, and
  under `os.tmpdir()`. claude sends its working directory, so in the story's isolated check `take_screenshot` with a
  `filePath` in the repository wrote the file there.

## Options considered
1. **The three edit tools only.** Bash still runs `sed -i`, `git commit` and `>`.
2. **Bypass plus a Bash deny list.** Open-ended: `tee`, `cp`, `python -c` and every redirect are escapes.
3. **dontAsk plus a read-only allow-list.** Everything not listed is denied; the residue is the flags of the
   programs listed, so the list holds one program that has no flags to abuse.
4. **No Bash at all.** Loses the SQL probe ADR-HFL-07 names.

## Decision
Option 3, narrowed.

1. **Role.** `tab create --role evaluator --preview-url URL [--pg-service NAME]` (`POST /api/cli/tabs` `role`,
   `previewUrl`, `pgService`) creates a local `claude-code` tab (the type is implied when omitted). It stores `role`,
   the URL's origin as `previewOrigin`, and `pgService` when given. No update path changes them, and a panelType
   change answers 409 `conflict` naming the role. These are refused with `invalid-request` (exit 2):
   - another type, a remote host (the remote kit has no evaluator configuration), or an unknown role;
   - a missing or non-http(s) preview URL, or one carrying credentials;
   - a host that is not plain hostname or IPv4 characters (`[A-Za-z0-9.-]`). This refuses `*`, `(` and `+` (URL
     Pattern syntax) and bracketed IPv6 (the MCP cannot compile it);
   - purplemux's own port, read from the server's configured port, not a literal;
   - a `~/.local/bin/headless-chrome` under Chrome 149 (the reason names its version);
   - a `pgService` that does not match `^[A-Za-z0-9_-]{1,63}$`, or one given without the role.
2. **Every launch applies it.** The role travels with the tab's launch options into tab create, the browser launch
   command, timeline resume, auto-resume and `tab restart`. A launch without the preview origin is not built. Each of
   those commands starts with `PGSERVICE=NAME claude ...` when the tab has a `pgService`; the prefix comes from the
   one helper every command builder uses (`claudeCommand`). The flags are:
   - `--tools Read,Grep,Glob,Bash`: the whole built-in set
   - `--disallowedTools` with Edit, Write and NotebookEdit, and `Read(...)` deny rules for `~/.purplemux`,
     `~/.config`, `~/.aws`, `~/.ssh`, `~/.claude`, `~/.codex`, `~/.gnupg`, `~/.docker`, `~/.netrc`,
     `~/.git-credentials`, `~/.pg_service.conf`, `~/.pgpass`, and any file named `*token*`, `*secret*`, `*.pem` or
     `*.key` anywhere (written `//**/<name>`: `//` is the filesystem root, and a bare `**/` would be relative to the
     cwd)
   - `Bash(docker:*)`, `Bash(ps:*)`, `Bash(pgrep:*)`, `Bash(lsof:*)` and `Bash(ss:*)` in `--disallowedTools`. They
     are in dontAsk's read-only set and show other sessions' argv, environment and logs.
   - `--permission-mode dontAsk`, and never `--dangerously-skip-permissions`, whatever the global setting says
   - `--allowedTools` limited to `Bash(~/.purplemux/bin/evaluator-sql:*)`, `mcp__chrome-devtools`, `Read`, `Grep`
     and `Glob` (the absolute path in the rule)
   - `--strict-mcp-config --mcp-config` with the one server `chrome-devtools`
   - `--setting-sources ''`, because allow rules merge across user, project and local settings, so a repository's own
     allow rules would widen the list. The hook `--settings` file still loads.

   The session starts with Bash, Glob, Grep, Read and the chrome-devtools MCP tools (32 in 1.12.0), measured at init.
   Bash runs the wrapper and Claude Code's own read-only commands (measured above); everything else is denied.
3. **Probes.** HTTP goes through the browser, on the preview origin only (`navigate_page`, `new_page`, or
   `evaluate_script` with `fetch`), and carries the preview's own session.

   SQL goes through `evaluator-sql "<sql>"` to the libpq service that the tab's `--pg-service` names. purplemux
   exports the service at launch, and the evaluator cannot change it: an environment prefix is denied, and nothing
   outside the evidence directory is writable. The guard is the service's role. That role must have:
   - `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`;
   - `SELECT` only, and no `CREATE` on any schema;
   - no membership in `pg_write_all_data`, `pg_signal_backend`, `pg_execute_server_program`, `pg_read_server_files`
     or `pg_write_server_files`;
   - no `EXECUTE` on `dblink` or the admin functions;
   - `ALTER ROLE ... SET default_transaction_read_only = on`.

   The wrapper's read-only transaction and its statement limits are defence in depth. A read-only transaction alone
   does not stop `pg_terminate_backend` or `dblink`. Measured: `select pg_terminate_backend(1)` ran in the wrapper's
   read-only transaction (`evidence/18/pg-client-proof.txt`).

   The wrapper takes exactly one argument, with no backslash and one statement. It runs
   `env -i HOME LD_LIBRARY_PATH=~/.local/lib/pg-client/usr/lib/x86_64-linux-gnu
   PGOPTIONS='-c default_transaction_read_only=on' ~/.local/lib/pg-client/usr/lib/postgresql/18/bin/psql -X -q -At
   -v ON_ERROR_STOP=1 -d "service=$PGSERVICE" -c "$stmt"`. It refuses, naming the reason, when `PGSERVICE` is empty
   or not a service name, and when that psql is missing.
4. **Browser.** `evaluator-chrome-mcp` runs the pinned `chrome-devtools-mcp@1.12.0` with `--headless --isolated
   --executablePath ~/.local/bin/headless-chrome --workspace ~/.purplemux/evaluator/<tabId>/ --no-usage-statistics
   --no-performance-crux --allowedUrlPattern <previewOrigin>/*`. Every other origin and port and `file:` are blocked;
   the launcher refuses to start without the pattern or on a Chrome under 149. It starts the server through `evaluator-mcp-filter.cjs`, which deletes
   `capabilities.roots` from the client's `initialize`, so claude's working directory is not a file root. It also sets
   `TMPDIR` to `<tabId>/tmp/`, so the server's always-allowed temp root is inside the evidence directory too.
   Screenshots land in that directory, which is outside every repository and survives the tab. The tab id comes from
   `PMUX_TAB_ID`; without one the launcher refuses to start. The filter runs on the server's own node, and the
   server's node directory goes first on PATH, so a tab whose login shell does not reach node still starts it.
5. **Never a coordinator.** An evaluator tab is refused as orchestrator (`orchestrator-candidate-invalid`) before any
   runtime proof is asked, in every mode.
6. **No new browser endpoint.** The Electron-only `/api/cli/tabs/{id}/browser/*` routes are unchanged (audit H7).

## Chrome requirement
The role requires `~/.local/bin/headless-chrome` to report Chrome 149 or later, because `--allowedUrlPattern` is a
no-op below it. It is checked at `tab create` and at every MCP start. On mdserver1 this is Chrome for Testing
156.0.8078.4 (playwright 1.64.1 `chromium-headless-shell`) at `~/.cache/ms-playwright/chromium_headless_shell-1248`.
Story 18 installed it beside the 147.0.7727.15 build; the shared wrapper picks the newest build for every caller.
Undo: `rm -rf ~/.cache/ms-playwright/chromium_headless_shell-1248`. The role is then refused on this host, naming
147.0.7727.15. Log: harness-flow-loop `evidence/18/host-chrome-156.log`.

## PostgreSQL client requirement
`evaluator-sql` runs psql 18.6 and libpq 18.6 (`postgresql-client-18`, `libpq5` 18.6-0ubuntu0.26.04.1). They were
fetched with `apt-get download` and unpacked with `dpkg -x` into `~/.local/lib/pg-client`, with no sudo; `ldd`
reports no missing library. On mdserver1, story 18 installed them and proved `select 1` through a disposable
`v2-pg17-fast` container. Undo: `rm -rf ~/.local/lib/pg-client`; `evaluator-sql` then refuses with "no psql at ...".
Log: harness-flow-loop `evidence/18/host-pg-client-18.log`.

## Remaining exposure
What an evaluator can still reach, by design:
- The preview origin, with any HTTP method: `evaluate_script` can `fetch` a POST under the preview's session, and
  clicks and forms submit as the owner would. The preview's own authorization is the guard for writes through it.
- The read-only Bash set and `evaluator-sql` (read-only transaction; the SELECT-only role is the database's guard).
- Read, Grep and Glob on every path outside the deny list. That includes the repository and other checkouts, and
  credential files outside the denied paths: `.env` files, `~/.npmrc`, `~/.pypirc`, `~/.kube/config` and similar.
- Claude Code's built-in read-only Bash set changes with its version. The role denies the process, socket and docker
  readers by name. `tests/unit/lib/evaluator-tool-refusal.test.ts` pins those denials on the version it ran on.
  Other host reads that still run (`ip addr`, `uptime`, `df`, `free`) carry no credentials.
- Its own evidence directory, for writes.

## Consequences
- An evaluator turn that tries anything outside the list gets a denial tool result and goes on; it never blocks on a
  permission prompt.
- `tests/unit/lib/evaluator-tool-refusal.test.ts` runs the real claude CLI with the built flags against a scripted
  Messages API. It forces Write, Edit, NotebookEdit, `touch`, `sed -i`, `git commit`, a command substitution and a
  redirect, with user and project settings that allow them, and checks `git status --porcelain` and HEAD. It is skipped
  where no claude CLI is installed (CI), and there `tests/unit/lib/tab-role.test.ts` pins the argv on its own. The
  same test pins the init tool list, the refusals of EnterWorktree, Task and CronCreate, and the credential denials.
- A user's or a project's settings (statusline, env, plugins' permissions) do not reach an evaluator.
- `--setting-sources ''` also stops the project's `CLAUDE.md` and `.claude/commands` from loading (measured on claude
  2.1.317: `/v2-evaluate` answers 'no command with that name is available'). A seat sends its instructions to an
  evaluator tab as prompt text. Story 25's `tools/evaluate.sh` sends the body of `.claude/commands/v2-evaluate.md`,
  with `$ARGUMENTS` filled in, through `purplemux tab send`. The body carries every rule it needs from `CLAUDE.md`.
  `--plugin-dir` is not used, because a plugin can carry hooks, which run outside the permission rules.

## What proves it wrong
A forced tool call under these flags that changes `git status --porcelain` or HEAD of the tab's cwd, or writes a file
outside `~/.purplemux/evaluator/<tabId>/`.
