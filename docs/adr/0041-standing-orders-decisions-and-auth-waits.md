# ADR-0041: Standing orders, NEEDS-DECISION into Mission Control, and auth waits

## Status
Accepted (2026-11-03, epic `harness-flow-loop`, story 14; architecture ADR-HFL-05 decisions 4-6). Extends ADR-0015
(a fourth watch kind, `auth`), ADR-0035 (the wake kind `standing-order`, urgent) and ADR-0037 (a server producer of
format-2 questions).

## Context
The owner's 572 messages of 20 Oct-3 Nov (harness audit, 2026-11-03) repeat the same rules: access already given 14,
act without asking 13 plus 7 grants, questions to Mission Control 12, consult v1 16, "surely we have the data" 10. A
rule said in chat lives in one seat's context until its next compaction; no other tab sees it. 19 messages were
manual-step reports (awslogin, VPN, merge) relayed to the tabs that waited on them. A question an agent ends its turn
on reaches the orchestrator as a nudge, and the owner only when a seat copies it into Mission Control.

## Decision

### 1. Standing orders
- Files: `~/.purplemux/standing-orders.md` (fleet) and `~/.purplemux/workspaces/<ws>/standing-orders.md`, 0600, written
  tmp + rename (a tmp name per writer) under one host lock. A file must start with its `# Standing orders:` header: an
  empty or header-less file is refused, never read as zero orders. Each `## SO-<n>` block has `text` (one line, at most 600 characters), `source` (the
  owner message id and its UTC date), `scope` (default the file's owner), `check` (a hook or test name, or `prose`),
  `state` (`active` or `struck`), `added`, and `struck: <UTC> — <reason>` once struck. Ids are unique across every file
  and never reused, so `SO-<n>` names one order wherever a handoff or a ruling cites it: `standing-orders-seq.json` keeps
  the highest id ever handed out, so an id survives the removal of the workspace directory that held it.
- Budget: the active fleet orders plus the active orders of one workspace, as rendered into its prompt, are at most
  8,192 bytes. An add that would pass it for any workspace it reaches is refused (`so-too-large`, exit 2) with the
  measured size and the workspace. The measure is the rendered section, not the files: struck orders stay in the files
  as history and cost no prompt.
- Authority: a fleet order is added or struck with the admin token; a workspace order by that workspace's tabs or the
  admin token. Every order carries a source, so an order names the owner message it came from.
- Delivery: the active orders are written into the workspace's `claude-prompt.md` (the `--append-system-prompt-file`
  every Claude tab loads) at server start, on every Claude launch (a local tab through `buildClaudeFlags` at create,
  restart and resume; a remote tab through `createRemoteSession`, which writes the file and ships it in the kit at every
  remote session create, and a remote restart reaps the session and creates it again), and when an order changes. The
  prompt file is written tmp + rename; a write that fails is logged and the launch goes on with the last file written. A change also sends each live agent tab it reaches
  one line through the tab event router, wake kind `standing-order`, class `urgent`:
  `[purplemux standing order] SO-<n> added|struck (<owner>): <text> — …`. A running session does not reload its prompt
  file, so the line carries the order's text.
- Seed: a missing fleet file is created with SO-1..SO-7, the W8 orders of ADR-HFL-05 decision 4, each sourced to the
  owner message the audit quoted for its cluster (`src/lib/standing-orders-seed.ts`). An existing file is never
  re-seeded. The seed is written under the host lock: the first start reads the fleet file once per workspace, all at
  once. A file in another layout is refused (`so-unreadable`), never read as empty; the prompt then says the orders
  could not be read. Seed SO-7 runs `purplemux board show --line`, which takes the tab's workspace from
  `PMUX_WORKSPACE_ID` when `-w` is absent; a test runs every command a seed order names through the CLI parser.
- Striking an order already struck is refused by state: `so-struck`, exit 3.
- CLI: `purplemux so add (-w WS | --fleet) --text T --source S [--scope S] [--check C]`, `so strike SO-N --reason R`,
  `so list [-w WS] [--all] [--json]`. Routes: `GET|POST /api/cli/standing-orders`,
  `POST /api/cli/standing-orders/<SO-n>/strike`.

### 2. NEEDS-DECISION opens a Mission Control item
- A classified stop whose last line starts `NEEDS-DECISION:` opens one item, whatever the tab's `reportOn`, unless an
  item for the same line is still open (candidate or open), whoever opened it: the worker repeating its line while it
  waits, or the orchestrator that opened the item from the note below; or the tab opened an item since its previous stop
  (the turn's start; `mission_item_openers.opened_at`). The item id is
  `nd-<16 hex of workspace, tab and the whitespace-normalized line><16 hex of the stop's time and seq>`: the first half
  names the question, and the store finds an open item by that id prefix (`openItemsWithIdPrefix`), from any opener;
  the second half takes the stop's time as well as its seq, which restarts at 0 with the server, so an answered question
  opens a new item after a restart too. Once the item is answered, resolved or cancelled, the same line opens a new one.
- The opener never throws: a failing dependency (an SQLite read, the workspace read, the module load) is the outcome
  `error`. Every outcome that opens no item (`no-orchestrator`, `no-orchestrator-run`, `refused`, `error`) carries the
  id the server would have used.
- The item opens before the orchestrator's nudge, and the nudge's end line carries one note:
  `[MC item <id> opened for the owner by the server: do not open another]`,
  `[MC item <id> already open for the owner: do not open another]`,
  `[MC item <id> opened by the tab this turn: handle it as any worker item]`, or a fallback note below. The
  orchestrator contract names each note and what it asks; it says never to copy such a question into Mission Control.
- The question is built from the whole last line of the turn's tail, not the marker line clipped at 300 characters for
  the nudge. The tail is the end of the message, so a line that starts inside it is whole; a line that runs from the
  first character of a tail cut at 600 characters may lack its start, and is then an `answerType: text` question whose
  context says the line was clipped.
- The line: an optional `[money|irreversible|scope|bookkeeping]` tag gives the class (none: unclassified); `(a) … (b) …`
  or `(1) … (2) …`, two to four in order, give the options of an `answerType: single` question. With no options, or
  an option label over 60 characters, the question is `answerType: text` and the options stay in the context
  verbatim. `decision` is the question clipped at a word to 120 characters; the context quotes the whole line.
- The item is format 2 (ADR-0037) and opens human-visible in one `attention.opened` event that carries the human
  review (`humanNeed: decision`) of the workspace's configured orchestrator, on that orchestrator's open run. The
  event goes through the events route's own batch function (`applyMissionEventBatch`): the same validator at the fleet
  minimum version, the server-resolved orchestrator identity, the store's review authority check, and the owner's
  attention-opened push (title "Mission Control: answer needed"; a tap opens the item), which a server-opened item
  sends like any other. The opener is the tab (`identity: hook`). Event ids `system:needs-decision:*` are reserved: no
  request may use them.
- Fallback when no item opens. Questions are answered in Mission Control; a push is a last resort.
  (i) An orchestrator can receive it: the reason is `no-orchestrator-run`, `refused` or `error`; the workspace has a
  configured orchestrator that is not the asking tab; the tab's escalation target is that orchestrator; and the
  orchestrator is a live agent tab (not retired, not inactive). Then the server sends no owner push, the nudge goes to
  the orchestrator even when the worker's `reportOn` withholds `NEEDS-DECISION`, and the note is
  `[no MC item (<reason>): open it yourself: resume or start your Mission Control run, then open item <id> from this line with your human review. The owner has not been told.]`.
  The id-prefix dedupe then turns the worker's repeat into `already-open`.
  (ii) No orchestrator can receive it (`no-orchestrator`, the asker is the orchestrator, or (i) fails): one push of
  alert kind `needs-decision`, title `Decision needed: no Mission Control item`, body
  `<tab name or id> · <workspace name or id>: <the line without the marker and the class tag, whitespace collapsed>`
  cut at 100 code points; it carries the tab and workspace, so a tap opens the tab. One push per workspace, tab and
  normalized line in 24 h, kept in memory (at most 2,000 keys, oldest evicted; a restart may send one more). The
  dispatch is never awaited. The note says what the server did, never what the owner received:
  `[no MC item (<reason>): owner push dispatched, delivery not confirmed]`, or
  `[no MC item (<reason>): owner push for this line already dispatched at <UTC ISO time>]`. Not the inbox: an inbox
  line carries no caller text (ADR-0012) and addresses a tab. Seed SO-6 says exactly this.

### 3. Auth waits
- Watch kind `auth`, target `aws-sso:<profile>`, until `signed-in`, interval 60 s by default; CLI
  `purplemux wait add --auth PROFILE [--item LEDGER_ITEM_KEY]`. It runs in the local lane with lease watches.
- Proof: the AWS CLI's own token cache file. `~/.aws/config` names the profile's `sso_session` (cache file
  `~/.aws/sso/cache/<sha1 of the session name>.json`) or a legacy `sso_start_url` (`sha1` of the URL). The token is
  valid when the file has an `accessToken` and an `expiresAt` at least 5 minutes ahead; a client registration file has
  no `accessToken` and proves nothing.
- It fires on a sign-in, a change: the baseline is the token valid at creation (`sso:<expiresAt>`, or none). A watch
  raised on a missing, expired or nearly expired token fires on the first valid one; a watch raised while a token is
  valid fires only when a different valid token appears (the owner signed in again), never at once.
- The cache read is this server host's `~/.aws`: an auth wait from a remote tab is refused (`watch-invalid`) with a
  message naming both hosts. The check fails closed: when the layout cannot be read or does not hold the calling tab,
  the wait is refused (`caller-unresolved`, exit 3) and never taken for a local tab. A profile that is not SSO is refused at creation (`watch-invalid`). An unreadable
  config or cache file is the failing token `sso-config`.
- No process is started and no AWS endpoint is called: DEC-261 forbids an agent run through the owner's SSO unless the
  owner asks. A test records every `child_process` entry point while a watch is created, read and fired.
- When it fires: one inbox line (`… aws-sso:<profile> is signed in: its SSO token is valid until <UTC>; retry the step
  that needed it — watch cleared`), then a ledger `clear` event from the server producer for the open `deploy-auth`
  wait of `--item`, and of every item of the workspace whose clear input names the profile as a word.

## Consequences
- A rule said once reaches every Claude tab at its next launch and every live tab at once; a strike does the same.
- An agent's question reaches the owner's Mission Control (web and the phone, APK 1.0.3) in the turn it is asked.
- The owner's `awslogin` is the signal; nobody relays "done".
- A remote tab loads the orders active at its create. A remote restart reaps the session and creates it again
  (`restartTabSessionUnguarded` -> `createSession` -> `createRemoteSession`), so it loads the orders active at the
  restart. The kit's copy goes stale only between launches: no path launches Claude on a remote host without a create
  first (auto-resume skips remote tabs; the launch-command route refuses them).
- The orchestrator receives the answer to a NEEDS-DECISION item, because it owns the run; it relays it to the tab.
- The nudge goes to the tab's escalation target; the item and its answer belong to the configured orchestrator.

## What proves it wrong
Owner repeats of the top clusters stay above 1 a week each after 14 days, or the owner still relays manual steps more
than once a week. Then the orders are not reaching the tabs, or the tabs do not read them: measure the prompt files
and the delivered `standing-order` events before adding mechanism.
