# Mission Control v1 implementation contract

Approved implementation scope: integrated responsive PurpleMux view, durable decisions, additive mobile API, live-workspace discovery and one bounded bootstrap reconciliation. The epic board is metadata only. Types in `src/types/mission-control.ts` are the shared wire contract. All timestamps are Unix milliseconds; IDs are opaque nonempty strings, at most 128 characters; revisions and cursors are nonnegative safe integers. Use server-owned workspace/session identities, never producer claims of identity.

## Storage and packaging

Use `better-sqlite3` with `@types/better-sqlite3`, under `~/.purplemux/mission-control.sqlite`. Version 12.11.1 explicitly supports Node 20 through 26 ([upstream manifest](https://raw.githubusercontent.com/WiseLibs/better-sqlite3/v12.11.1/package.json)); pin a compatible adapter version rather than assuming latest supports Node 20. Do not use `node:sqlite`, which is unavailable on the declared Node 20 floor. WAL, foreign keys, busy timeout and `synchronous=FULL`; schema version migrations; restrictive file permissions. Native installation/build must be verified on local Node 24 and supported Node 20. Externalize the adapter in Next `serverExternalPackages` and tsup; trace its binary into standalone, retain the existing standalone asar-unpack rule, and rebuild that nested copy for each Electron target and architecture. A production standalone open/write/reopen test is required; Electron packaging must be verified on its supported build platform or reported explicitly as unverified.

One synchronous transaction persists each mutation, its derived current rows, durable event, answer and delivery job. A database error returns 503 and produces no success notification. Tables: runs, attention_items, answers, deliveries, events, bootstrap, bootstrap_entries; unique producer event ID and answer submission ID. Compare stored content hashes on duplicate IDs: identical requests return the original result before optimistic concurrency checks; changed payload returns 409. Store sequence as SQLite INTEGER. First release retains all events: no retention or cursor expiry to implement yet. Snapshot current rows and max event sequence in one read transaction. Harness observations may be added afterward with their own `observedAt`; these are explicitly live observations, not part of the durable cursor.

Schema 4 adds nullable `human_review_json` and `candidate_reason` columns. Its 3→4 migration transaction reclassifies only unanswered legacy opens to `candidate` with reason `legacy-review`, increments each item revision once, and appends one deterministic `attention.reclassified` audit event per item. It preserves IDs, question content, evidence, creation time, source key, history, answers, deliveries, bindings, and bootstrap records. An open item already linked to an answer aborts migration for investigation; any failure rolls back the columns, rows, events, and schema version together. Deployment takes a consistent backup and stops the old writer first. A schema-3 binary cannot reopen schema 4, and rollback after new writes must preserve the upgraded database rather than restore a stale backup.

Use a process-shared `globalThis.__ptMissionControlStore` and `globalThis.__ptMissionControlRuntime`. The custom server and Next API bundles instantiate modules separately. Store constructors accept a scratch DB path for tests. Runtime worker is started once by server startup and stopped on shutdown; importing an API handler must not create duplicate timers.

## HTTP and CLI

Human routes require a verified `session-token` in the handler, even though the proxy also accepts a global CLI token. Mutation routes require matching Origin when present and reject cross-site Fetch Metadata. Browser requests must supply their same origin; native mobile requests supply the configured server Origin with their existing cookie. Do not accept an agent/global token as a human identity. Human actor is the verified JWT subject (`user` in current auth), recorded by the server. A subject that starts with `system:` is refused with 403: system actors are server-only (ADR-0031 §8).

| Method | Endpoint | Request / response |
|---|---|---|
| GET | `/api/mission-control` | `IMissionSnapshot`; authenticated feature detection uses 404/405 as unsupported, never treats 401 as unsupported |
| GET | `/api/mission-control/events?after=0&limit=100` | `IMissionEventsResponse`, maximum limit 200; cursor is last returned event or input cursor when none, never skip a page |
| POST | `/api/mission-control/items/:itemId/answers` | `IMissionAnswerRequest` → `IMissionAnswerResponse`; 201 new, 200 replay |
| POST | `/api/mission-control/bootstrap` | `{bootstrapId:string,reconcile:boolean}` → `IMissionBootstrap`; discovery always safe, reconcile queues exactly one request per eligible current binding |
| GET | `/api/cli/mission-control?workspaceId=...` | workspace-filtered `IMissionSnapshot`, including persisted answers and `humanInboxPolicy` |
| POST | `/api/cli/mission-control/events?workspaceId=...` | `{events:TMissionProducerEvent[]}` → `{events:IMissionEvent[],cursor:number,replayed:boolean,humanInboxPolicy}`; maximum 25, atomic batch |

CLI API resolves workspace token and requires `canDriveWorkspace` for every write: no global-token exemption or allowed-peer mutation. Every event's workspace must equal authorized query scope; all referenced run/item/answer rows must belong to that workspace and run. Reads use existing read authorization but only return the authorized workspace. A workspace token is the current trust boundary: it does not establish which sibling tab produced an event. Generation checks prevent stale logical writes; do not claim tab-level authentication stronger than existing tokens.

Commands are `purplemux mission snapshot -w ID`, `purplemux mission bootstrap -w ID` (pending reconcile steps, plus each open bound run with its revision, bound tab and binding generation), `purplemux mission events -w ID --json '{"events":[...]}'`, `purplemux mission answers -w ID [--run ID] [--all]`, and `purplemux mission ack -w ID --run ID --answer ID --generation N --revision N --event-id ID --producer-at MS`. The default answer read returns current unacknowledged work; `--all` includes history. Both answer forms forward `humanInboxPolicy` so an ordinary turn can review pending legacy candidates without a new wake-up. Ack is a convenience around `answer.acknowledged`, and its stable producer timestamp makes a lost-response retry byte-for-byte idempotent. Document candidate creation, orchestrator review, workspace handling, and resolve examples in CLI help and api-guide; no separate ambiguous lifecycle command layer required. Bootstrap is human-authenticated HTTP; the integration operator can call the internal service once after deployment without impersonating a human answer.

Set `Cache-Control: no-store`, reject invalid payloads with 400, auth with 401/403, absent entities with 404, invalid transitions/stale generations/revisions/changed idempotency payloads with 409 and current row where appropriate. Reject oversized bodies (64 KiB), unknown event types, unbounded arrays, duplicate option IDs, invalid option selections, invalid URL schemes (http/https only), and empty answers. Titles/objectives max 500 characters, context/text/resolution max 8000, options/story IDs max 20. Keep duplicate submissions bound to original item and payload.

## State transitions

`run.started`: expectedRevision=0, bindingGeneration=0; allocate run revision 1 and generation 1 after verifying the named agent tab belongs to workspace and has a current provider session. A provisional bootstrap run may start with binding=null and cannot deliver until explicitly resumed/confirmed. `run.resumed` requires the old run revision and generation, resolves current tab identity server-side, increments generation, and transfers pending answers only when explicitly requested. Old bound deliveries otherwise remain held. All other producer events must match current run bindingGeneration. Run state is explicit semantic state; harness idleness never completes a run.

Orchestrator rebind (server-authored): each committed change of the workspace orchestrator tab — `orchestration handoff`, `orchestration recover`/`on`, a human replacement or start — calls the runtime once, inside the mapping write lease. It resolves the new orchestrator's live identity server-side and, in one store transaction per workspace, moves every open bound run (state neither `completed` nor `cancelled`) to that identity: `binding.generation` + 1, `run.revision` + 1, and one `run.rebound` event (`entityId` = run ID, event ID `system:rebind:<hash>:<generation>`, a reserved namespace) whose payload is `IMissionRunReboundPayload`: `cause` (`handoff` | `recover` | `replace` | `heal`), `previousBinding`, `binding`, `actor: system:orchestration`. Run state, evidence and progress time do not change: a rebind is not agent confirmation. A run already on that identity is skipped, so a repeat is a no-op; finished runs, other workspaces and unbound provisional runs (still bound by `run.resumed`) are untouched. Deliveries follow the `run.resumed` transfer rules: `dispatching` becomes `held` with `transport-uncertain:run-rebound-during-dispatch` and is never sent again; `queued`, `held` and `failed` rows of still-answered items that are not transport-uncertain are requeued on the new binding. A binding is never written from a guess: when the identity does not resolve at the commit point, the rebind stays pending in the runtime and the worker retries it every 5 s against the then-configured orchestrator, under the mapping read lease. Once per process the worker also heals earlier state: a run whose bound tab is absent from the workspace layout and differs from the configured orchestrator is rebound with cause `heal`, only when that orchestrator's identity resolves. A `handoff` or `recover` that names the coordinator already in place changes no mapping revision and still runs the rebind, so `purplemux orchestration recover -w WS TAB` re-asserts the binding of a run left on a tab that is still open. A failure after the mapping commit is logged and retried; it never fails the orchestration change. Producers cannot send `run.rebound` or use its event-ID namespace.

For run events, expectedRevision targets run.revision. For attention events, it targets item.revision (0 on open). For acknowledgement, it targets the answered item's current revision. Every semantic item transition increments its revision. Events for one entity cannot overwrite another entity. Attention mutation does not increment run.revision, so independent question/progress updates need not conflict. Acknowledgement records delivery state and event without changing the question revision; repeat same acknowledgement is an idempotent success. Ordinary `attention.opened` and candidate updates remain candidates. A configured-orchestrator review may promote the same item ID only when it names a human-exclusive decision, approval, information, or external action; a `none` review records workspace handling. Changing an open question requires renewed review. An answered question must be explicitly cancelled and replaced with a new ID to change its content.

`attention.opened` and `attention.updated` accept optional strict `humanReview`. A human need supplies `humanNeed`, `humanReason`, `handling`, and `reviewerTabId`; `none` omits `humanReason`. Review text is trimmed and limited to 1–1,000 characters. The server stamps the current binding, event ID, and review time in separate item metadata. Before commit it requires the reviewer tab to equal the configured orchestrator, the run to be bound to that tab, and the live resolver identity to match the bound provider, session, and runtime generation. This is a server-checked process assertion under the shared workspace token, not authenticated tab authorship. A sibling with that token could claim the orchestrator tab ID; preventing deliberate impersonation requires a stronger per-tab credential.

Answer transaction: require an item that is open with a stamped human-exclusive review and matching revision, then validate selected options/text/action flag; persist answer, set item=answered with revision+1, enqueue delivery with immutable current binding, append answer.recorded event. Multiple taps with the same submission ID replay; a different submission against the now-answered item gets 409. Item resolution requires its answer to be acknowledged; an unnecessary/unanswered item uses explicit cancellation. Run finish never auto-resolves/cancels attention records. Item cancellation makes pending delivery ineligible without deleting answer history. Deleted workspaces retain orphaned rows and unanswered items.

**Attention class and stated default (ADR-0031).** `attention.opened` and `attention.updated` accept optional `class` (`money` | `irreversible` | `scope` | `bookkeeping`) and optional `defaultOptionId`, which must name one of the item's `options[].id` and is refused on an `action` item. An unknown class or a foreign default refuses the whole batch with 400 and a message that names the field. Both fields live inside `question_json` (read by the plain spread), so `SCHEMA_VERSION` stays 4 and a schema-4 binary rolled back onto the file passes the keys through on read and refuses them on write (`.strict()`; ruling R10). `IMissionAttentionItem` carries `class` and `defaultOptionId`, `null` when absent; the server never guesses a class. `attention.updated` replaces both under the item revision rule, and a change of either on an open item needs renewed review. `IMissionSnapshot.answersByClass` lists `{day, class, by, count}` for the 7 UTC days that end on the UTC day of the snapshot's `generatedAt` (today included), from `answers` joined to `attention_items` in the snapshot read; `class` is `unclassified` for an item without one, and `by` is `rule` only for the actor `system:auto-answer`. Rows are sparse: when `answersByClass` is present, a missing (day, class, by) row is a count of 0; when the field is absent (an older server), the counts are unknown. "Needs you" groups items Money, Irreversible, Scope, Bookkeeping, Unclassified; a card shows its class and "Default: <option label>" and never pre-selects the default.

**Question format v2 (ADR-0037).** `question_json.formatVersion: 2` marks the format-2 question (`decision`, `whyNow`, `answerType`, options with `consequence`/`recommended`/`needsText`, `recommendationWhy`, `evidence`, markdown `context`, `source`); an item without it is v1. One pure validator (`validateMissionQuestion`, `src/lib/mission-question-format.ts`) checks both attention events; a refusal is 400 `question-invalid` with every defect (`field`, `measured`, `limit`) and nothing written. Fleet config `mission.question-format.min-version` (admin only, default 1) decides whether a new v1 question is accepted with `lint` (1) or refused (2); at 2 an update may keep a v1 item v1 but not turn a format-2 item back into v1. Each `attention.updated` stores a `changes` record in the side table `mission_item_changes`; an answer on revision r applies to the current r' when every revision between them is compatible (same decision and answer type, no option removed) and records `appliedRevision`; otherwise 409 with `changes`. The served item carries `evidenceLinks`, `lint` and `changes`. The web card renders the decision first, the markdown context, and an answer control per answer type; a revision never leaves Submit disabled without a reason on screen. `purplemux mc ask` runs the check route before it posts.

**Bookkeeping auto-answer (ADR-0031 §4-§8).** Fleet config `attention.auto-answer.bookkeeping-minutes` (admin token only) is an integer 1..10080; unset or invalid is off, and an invalid value is logged. A 60 s tick (`globalThis.__ptAutoAnswerTick`, started beside the Mission Control runtime, stopped in `shutdownWs`) calls `MissionControlStore.submitSystemAnswer` for each item that is `open`, has a review whose `humanNeed` is not `none`, has `class: bookkeeping`, is not an `action`, has a `defaultOptionId` naming a current option, and whose `updated_at` is at least N minutes old. Inside the answer transaction the store re-checks all of these and the revision the tick read (`expectedRevision`), so a human answer or a cancel that came first wins (409) and a race leaves one answer. The answer is `optionIds: [defaultOptionId]`, actor `system:auto-answer`, `submissionId` `auto:<itemId>:<revision>` (a repeat replays, so a restart never answers twice) and text equal to the note: `Auto-answered under fleet config attention.auto-answer.bookkeeping-minutes=<N> (version <v>) at <ISO time>: applied the stated default "<option label>".` Its `answer.recorded` payload adds `actor: system:auto-answer`. The same transaction writes one row of the unversioned side table `mission_auto_answers(answer_id PRIMARY KEY, item_id, workspace_id, rule, rule_version, applied_option_id, at, note)` (`CREATE TABLE IF NOT EXISTS`; `SCHEMA_VERSION` stays 4). Delivery, acknowledgement and resolution are the human path; the rule never resolves or cancels. Each item carries `autoAnswer: {rule, ruleVersion, appliedOptionId, at, note} | null`; the snapshot carries `autoAnswered` (7 days, newest first, at most 100). The submission namespace `auto:` and the event-ID namespace `answer:auto:` are reserved (400). Each rule answer appends one `attention-auto-answer` audit line (`itemId`, `workspaceId`, `rule`, `ruleVersion`, `optionId`, `ageMs`).

## Delivery and bootstrap worker

Integration owner supplies runtime observations and delivery scheduling. Persist `dispatching` plus incremented attempt count before transport. If restart finds dispatching, hold with an uncertain-delivery reason rather than automatically pasting again. Queue readiness retries (e.g. 5s/15s/60s) do not paste or spend model tokens. Successful paste sets submitted, never acknowledged/resolved. No repeated automatic wake-up after submitted; agents can discover and acknowledge outstanding answers on their next ordinary turn. Transport errors with unknown paste outcome are held visibly. Deterministic pre-send refusal may retry; binding mismatch is held until explicit run resume. Recovery must preserve all jobs.

Reuse the automated dispatcher/model-policy lock and add a request-specific safe-delivery precondition inside that lock immediately before paste. Require exact workspace/tab/provider session and generation, current provider process alive (`provider.isAgentRunning` / existing tmux process utilities), supported agent panel, empty/ready composer, no permissionRequest/native prompt, and no in-progress user composer content. Do not use the human `live-session` send path. `needs-input` is not by itself safe: it may be a native permission or interactive prompt. If readiness cannot be established, hold and expose why. Codex must match its active launch generation; where provider lacks launch identity, use current session identity plus explicit Mission Control generation and refuse ambiguous transitions.

Delivery prompt contains durable item/answer IDs and exact read/ack CLI commands, not a claim that work was already applied. Agent reads the stored answer, explicitly acknowledges it, then resolves after applying it. The API can guarantee durable answer acceptance; terminal delivery is at least once under explicit retries, and consumed delivery requires acknowledgement.

Bootstrap enumerates all real workspaces/layouts, latest standups and current StatusManager/provider identities. Never consult open epic rows to infer activity. Live busy workers count even when orchestrator idle. Agent panels only; terminal/browser tab liveness is not work. Separate observed activity from semantic progress; polling, heartbeat and repeated standup prose do not advance progress. A recent standup may provide provisional objective/phase/next-step and blocker candidates, not confirmed questions or completion. Use deterministic source keys such as workspace/session/standup timestamp; no arbitrary transcript scan. Preserve all inferred facts with provenance and confidence. Active evidence requires substantive current execution, explicit wait produces waiting, reliable absence produces dormant, contradictory/unreadable evidence unknown. Mark prolonged busy/no-progress as stale rather than completed.

Bootstrap creates or fills a provisional run only when no current semantic run exists. Capture initial event boundary, then merge per entity revision; never replace existing confirmed fields or newer events. For live-only discovery, the source identity is the sorted set of verified tab/provider/session/runtime-generation tuples. Store the union of identities observed for each run as internal bootstrap metadata. An active run remains authoritative and accumulates identities. A terminal run is a tombstone: exact-source replay, an empty identity set, or a set contained in the workspace's durable history creates nothing; at least one previously unseen verified identity may seed one new provisional run. Removing or recombining known identities is not evidence of new work. This metadata does not change the wire snapshot or infer semantic state. Repeated bootstrap IDs return recorded progress; new bootstrap IDs must still reuse source/workspace/session keys to avoid duplicate runs, candidates and successful reconciliation requests. Historical blockers are workspace candidates, excluded from the human inbox until explicit configured-orchestrator review identifies a human-exclusive need. Current run.started/resumed/progress confirmation binds/updates the existing provisional run rather than creating a second run. Missing live orchestrator leaves visible provisional state.

Reconciliation queues one compact request only to a verified current orchestrator binding, uses the same readiness guards, and staggers requests. Mark attempted before send. Submitted/uncertain requests are never automatically repeated. Include bootstrap ID, provisional run ID and current revision/generation in the prompt; orchestrator uses events to confirm objective/phase/current questions and resolves candidate uncertainty. A completed request is recognized from confirmed agent events for that provisional run. No replacement agents, per-refresh summarization or perpetual reconciliation nudges. Populate actual live workspaces once after scratch acceptance and deployment; do not inject into live sessions during implementation tests.

## UI, integration boundaries and validation

Web route `/mission-control`, existing login/nav, responsive cards: Needs you contains only explicitly reviewed human items; Workspace issues contains candidates with legacy-review, orchestrator-handling, or review-required copy; awaiting acknowledgement, workspaces (active/waiting/dormant/unknown filters), and collapsed recent events remain separate. Poll snapshot while visible (about 5s), stop/background backoff; no model calls. Preserve answer draft and submissionId when an item is migrated to candidate, on network failure, and on 409 until success or deliberate edit. Candidate submission stays disabled; same-ID promotion uses the explicit revision-adoption flow. Display “Why you’re needed” from the stamped human reason. Surface delivery held/failed, source/confidence, orphaning, separate activity/progress timestamps, closeout pending only from explicit report. Mobile uses same snapshot/answer endpoints and cookie session, additive unsupported state on older servers; no global token on phone.

Worker ownership: core owns types/validation/SQLite/API/CLI and store unit/API tests; runtime owns bootstrap/delivery/server lifecycle/provider guard tests and instrumented adoption text; web owns responsive page/nav and UI behavior tests. Core and runtime agree store methods before parallel editing; runtime should call durable transaction methods, never raw SQL. Mobile implementation starts when a worker slot frees and consumes these types without inventing endpoints. Packaging/integration owner resolves dependency/config edits.

Required focused evidence: persisted open question survives progress/reopen; answer idempotency and competing device conflict; atomic rejection on DB failure; restart at before/after paste never loses answer or falsely acknowledges; stale binding/native prompt/shell/orphan refusal; workspace-scope and human-cookie/Origin enforcement; consistent snapshot/replay; duplicate/bootstrap-after-new-event protection; worker-active/orchestrator-idle classification; non-actionable historical candidates; 320px web layout and existing navigation; mobile old-server feature detection and draft retention. Then repository test/type/lint/build gates once at integrated SHA.

Deferred integrations: native provider permission responses, epic-board API/state reconciliation, scheduler/reprioritization, event retention, offline durable mobile mutation queue, and transcript LLM summarization. Existing standup stays compatible; transition-only Mission Control reporting must be described in kickoff/resume adoption without quietly claiming installed external skills changed. No completion claim until actual workspace bootstrap has been run and reported with provisional/held entries visible.

## Coordination panel (story 20, epic purplemux-portfolio-coordination)

`GET /api/mission-control/coordination` (human session only; a CLI token gets 401) serves one read-only
snapshot: leases (with `holderState`, age, expiry), open notes, watches of every workspace, active grants,
held inbox deliveries, host pressure and host signals. Each section is its own `{ ok, items } | { ok: false,
error }`, so an unreadable store shows its error and never blanks the others. It adds nothing to
`IMissionSnapshot` or the Mission Control store.

- **Host** (Linux; `statfs`): disk used % and free bytes for `/` and, when it differs, the filesystem of
  `~/.purplemux`; inode use of `/` and `/tmp`; load average; memory available. Disk ≥ 90 % or inodes ≥ 85 %
  render as warnings. Off Linux the section says why, never zeros.
- **Host signals**: set `hostSignalCommand` in `~/.purplemux/config.json` to a shell command that prints the
  architecture's "Host-signal JSON" (`schemaVersion`, `stampedAt`, `gateSlots`, `worktrees`, `tmpInodesPct`;
  unknown keys ignored). The server runs it every 5 minutes with a 10 s timeout (the config is re-read each
  run) and validates it with zod. The panel shows the values and the run stamp, marks them stale after 15
  minutes, shows a failing command's or a validation error's text, and says "not configured" without one.

- **Deploys** (ADR-0029 §9): the `deploys` section, `{ ok: true, items: IDeployRow[] } | { ok: false, error }`
  (`src/types/coordination.ts`), absent from a server older than story 06. Each item is one announcement of the last
  24 h, newest first: `{id, reason, createdAt, restartAt, phase: 'pending'|'past', by, recipients: {total, delivered,
  queued, held, dropped}}`. A notice the inbox no longer has counts in `total` only. The section reads
  `~/.purplemux/deploy-announcements.json` and the inbox; either one unreadable fails this section alone.

### Human coordination actions (ADR-0029 §6-§10, story 06)

Three cookie routes act on the coordination rows. Each needs the human session cookie and this server's Origin;
a CLI token, no cookie or another Origin gets 401/403. None of them types into a tab. Each calls the same service
function as its CLI route, and every route answers `Cache-Control: no-store`.

| Route | Body | 2xx | Refusals |
|---|---|---|---|
| `POST /api/mission-control/notes` | `{toWorkspace?, toEpic? /*exactly one*/, subject /*≤120*/, body /*≤16 KiB*/}` | 200 `{note: INoteView}` | 400 `note-invalid` / `note-too-large` / `note-target-missing` · 409 `note-cap` |
| `POST /api/mission-control/inbox/{id}/retry` | — | 200 `{item}` | 404 `inbox-not-found` · 409 `inbox-not-held` · 409 `inbox-not-retryable` with `reason` |
| `POST /api/mission-control/leases/break` | `{name, reason /*1..500*/}` | 200 `{broken: ILeaseView}` | 400 `invalid-request` · 404 `lease-not-found` |

- **Note as owner.** The note carries the existing `human` admission (`NotesService.sendHuman`); its recipient
  sees it from "human" (`fromLabel`, `noteFromWords`), and it routes to the target workspace's enabled orchestrator. `toEpic` resolves now, at send time,
  to the workspace of the live `epic:<slug>` holder; with no live holder the route answers `note-target-missing`.
  On this route `note-too-large` is 400 (the CLI route answers 413). **A human never acknowledges a note:** a human
  is never a note recipient (ADR-0013), so no human ack exists, on the web or the phone.
- **Inbox retry.** It re-queues one held notice of any workspace once, with a fresh budget, as `inbox retry` does. A
  refusal-budget hold (`… (N refusals)`) and a 24 h hold (`… (undelivered after 24 h)`) are retried: that is what retry
  is for. `humanRetryRefusal(item)` refuses three holds by the leading token of `heldReason`, and the 409 body names it
  as `reason`: `stranded-in-composer` and `transport-uncertain` (the line may already sit in the composer or be
  submitted, so a retry can type it twice), and `target-not-agent` (it can never be delivered). The inbox has no ack
  (ADR-0012).
- **Lease break.** It runs the admin `lease break` transition. The coordination audit line `lease-release` (reason
  `broken`) records `by: {human: <session subject>}` and `breakReason`. Only the holder releases a lease (ADR-0011);
  a human breaks one, with a reason.

The web panel offers "Retry" on a held row the predicate allows, "Break…" on each lease (a dialog with a required
reason), and "Send note as owner" (a form). Each result shows as a sonner toast: the served refusal sentence for a
body with a contract `code`, else the failed request. The fleet status view stays read only (ADR-0023). The phone
(story 14) calls the same three routes.

## Fleet status (ADR-0023)

`GET /api/mission-control/coordination` adds a `fleet` section, `{ ok: true, view: IFleetView } | { ok: false, error }`
(`src/types/fleet-status.ts`), absent from an older server. One row per agent tab: state, time in that state, registered
waits, the last end line, the SM-inbox items the tab opened, and the STALL? / WAITING-LONG / UNANSWERED flags (UNANSWERED
also marks a tab still stopped on a `BLOCKED:` or `NEEDS-DECISION:` line). Thresholds
are fleet config minutes: `fleet-status.stall-minutes` (30), `fleet-status.waiting-long-minutes` (120),
`fleet-status.unanswered-minutes` (30), `fleet-status.composer-minutes` (2). The panel is read only. `view.errors`
entries are `{scope, error}`; a workspace's layout error also carries `workspaceId` (additive, purplemux-flow story 10),
because a workspace name can equal a scope name.

**Flag alerts (ADR-0032).** A flag that is raised also reaches the human with no poll: the server's 60 s flag tick sends
one status-socket `notification:alert` of kind `flag`, `flag: {source: 'fleet', rule, subject, text}`, to the flagged
tab (or to the enabled orchestrator for a workspace's unattributed UNANSWERED). Rules, baseline and switch:
`docs/STATUS.md` § Flag alerts.

**Opener attribution (advisory).** The CLI events route records who opened each new `attention.opened` in the unversioned
side table `mission_item_openers`, inside the same transaction. The opener comes from the server-resolved caller
credential (ADR-0010), never from the payload: `launch` is verified, `hook` and `session` are asserted. It is not
authorization, and `IMissionSnapshot` and the event feed do not carry it. A missing row means unattributed. The
trust-boundary sentence above still holds for a workspace-token caller; a launch tab token does name its tab.

## Board (ADR-0034)

`GET /api/mission-control/board?workspaceId=all|WS` (human session only; a CLI token gets 401; default `all`)
answers `IBoard` (`src/types/constraint.ts`) for one workspace, or `{boards: IBoard[]}` for all; an unknown
workspace answers 404. `GET /api/cli/workspaces/{ws}/board[?mine=1]` serves the same answer with read scope, and
`board show -w WS [--json|--line|--mine]` prints it. The answer is the constraint finder's cached result (a 60 s tick,
`src/lib/constraint-tick.ts`) plus `needsYou`, Mission Control's open items (`{id, title, createdAt, blocked}`; null
when the store is unreadable), and `experiments` (the ledger's experiments with no verdict; null when unreadable).
`blocked` is `{items, hours, critical}`: the open ledger items waiting `owner` whose link (parent) is `mc-item:<id>`,
their summed waiting hours and whether any is critical; null when no ledger item links to the MC item, and null for
every row when the ledger is not measured (the faces then say "blocked cost not measured: <ledger reason>", apart
from "no ledger item links to this item"). `inputs.ledger.state` other than `ok` means the ledger measures (constraint, stuck, windows,
anomalies, `ownerBlocks`) were not taken; `onTrack.goal` is null until `purplemux board goal set`, and `onTrack.state`
is then `at-risk` with `reason` "no goal set" and `goalState: none`; an unreadable goal file is `goalState: unknown`
with `reason` "goal not measured: <reason>", never "no goal set".

**Goal** (story 12 AC 5). `GET|PUT|DELETE /api/cli/workspaces/{ws}/board-goal` (`PUT {label, items}`; writes from the
workspace's own token only) and `purplemux board goal set -w WS --items KEY,KEY --label TEXT | show | clear`. The goal
is stored in `workspaces/{ws}/board-goal.json`; a write drops the finder's cached answer, so the next read forecasts it.
`onTrack` then carries `itemsLeft` (goal keys the ledger does not hold closed), `throughputPerDay` (closes of the goal
keys' item types in each of the last 3 days, dropped and superseded left out), and `p50At` / `p90At` from an exact
bootstrap over those days (`src/lib/board-forecast.ts`, pure); no close in 3 days is no forecast, never a date.

**Pulse** (ADR-0034 §9). `GET /api/mission-control/pulse?workspaceId=all|WS` (human session; `{pulses: IPulse[]}` for
all) and `GET /api/cli/workspaces/{ws}/pulse` (read scope; `purplemux board pulse -w WS [--json]`) answer `IPulse`
(`src/types/pulse.ts`): 48 clock-hour bars of movement, each source's own state, the stall marker, work in progress
with its basis, and priority now. Cached 60 s per workspace; each source read has a 10 s deadline, and reads on the sshfs `_output` mount run at most 2
at a time behind a breaker ("<mount> not answering since <time>"). `scope` says whose
movement it is: an epic lease's records and repositories, or the workspace's own directories; a source read from a
directory another workspace lists too carries `sharedWith` and is never counted (ADR-0034 §9).

**The view.** `/mission-control` (`?view=board`, the default) is the board: the pulse rows first, then one workspace's
sections in ADR-HFL-02 order. `?view=answers` is the Needs you answer list and `?item=<id>` opens it on that item's
card; `?view=portfolio` is the portfolio board. The board sends no write.

## Flow (ADR-0026)

An orchestrator publishes its pipeline with `purplemux flow publish -w WS --json @FILE` (`IFlowSnapshot`,
`src/types/flow.ts`); the server keeps the record and one history row per publish in `workspaces/{ws}/flow.json`.
`GET /api/mission-control/flow` (human session only; a CLI token gets 401) lists each workspace with a record:
`{workspaceId, workspaceName, receivedAt, generatedAt, source, stale, producerFlagCount, derivedFlagCount}`, and an
unreadable record goes to `errors` without blanking the list. `?workspaceId=WS[&history=window|none|all]` answers
`{workspaceId, flow, stale, derived}` (default `history=window`); an unreadable record answers 503
`storage-unavailable`. `GET /api/cli/workspaces/{ws}/flow` serves the same `derived` answer from the same service
(`src/lib/flow-view.ts`), and `flow show` prints it. `derived` is absent when there is no record, and from a server
before purplemux-flow story 02; a client without it still parses the answer.

**Derived flags** (`deriveFlowFlags` in `src/lib/flow-flags.ts`, pure). They come from the full record, whatever
history the answer carries, and sort `block`, then `warn`, then by rule and subject.

| Rule | Severity | Raised when |
|---|---|---|
| `stale` | warn | no publish for 10 min. A stale record raises only this flag; the other rules do not run. |
| `lock-busy` | warn | the lock's busy share over the window is at least `flow.lock-busy-percent` |
| `queue-long` | warn | a queue holds at least `flow.queue-length` items |
| `queue-old` | warn | a queue's oldest item is older than `flow.oldest-minutes` |
| `queue-full` | block | a queue with a `capacity` holds at least that many items |
| `meter-over` | warn | a meter's `value` is above its `limit` |

The busy share is time-weighted: each history row's lock state holds from its `at` to the next row's `at`, and the
newest row holds until now. A gap longer than 10 min, a negative interval (the clock stepped back) and a row without
the lock are unknown time, on neither side; no instant counts twice. If the known time is less than half the window,
`lockBusyShare` is `null`, the lock is in `insufficientHistory`, and no flag is raised. `lockKnownMinutes` gives the
known time. The shares are served on a stale record too; there, the time since the last publish is unknown time.

**Flag alerts (ADR-0032).** Each derived flag also raises one `notification:alert` of kind `flag`,
`flag: {source: 'flow', rule, subject, text}`, from the server's 60 s flag tick, addressed to the workspace's enabled
orchestrator tab; with no orchestrator, nothing is sent. The tick derives from the stored record, never from a served
answer. Fleet config `alerts.flags` (`off` disables) and `alerts.flag-repeat-minutes` (60) are admin-written only.
Rules: `docs/STATUS.md` § Flag alerts.

**Fleet config keys** (ADR-0019; the admin token or the workspace's enabled orchestrator writes them). An unset or
invalid value reads as the default, and the server logs why. The served `thresholds` state the values in use.

| Key | Default | Valid values |
|---|---|---|
| `flow.window-minutes` | 360 | 10..10080, decimals allowed. It also sets the rows of `history=window`. |
| `flow.lock-busy-percent` | 80 | 1..100, decimals allowed |
| `flow.queue-length` | 10 | a whole number 1..10000 |
| `flow.oldest-minutes` | 240 | 1..10080, decimals allowed |

**The panel** (`src/components/features/mission-control/flow-panel.tsx`) is on the default Mission Control view,
after "Needs you" and before the portfolio board, and only when a workspace has a record or an unreadable one. It
selects the newest published workspace by default and keeps that selection until the workspace leaves the list. It
polls both GETs every 60 s while the page is visible; the detail asks `history=none`, since the panel draws no rows. It shows
the derived and producer flags first, then each queue as a bar of its items (coloured by state, pinned items marked,
the oldest item's age, the capacity), the locks (holder, held since, busy share) and the meters against their limit.
A stale record shows "stale — last published <age> ago" above the data; the panel also decides staleness from the
record's `receivedAt` at render time, so a last answer kept through failed refreshes turns stale too. The busy sentence
("held 92% of the last 6 h", or "held 100% of 3 h 1 min known in the last 6 h" when the known time is shorter than the
window) is built by `lockBusyPhrase` for the flag text, the panel and `flow show`. The shown percent is rounded down, and
the rule compares busy and known milliseconds, so a shown percent never meets the threshold without the flag. It sends
nothing to a tab and writes nothing.
