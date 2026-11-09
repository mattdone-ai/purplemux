#!/usr/bin/env node
// Wave-1 to wave-5 acceptance checks against an ISOLATED purplemux instance (stories 07, 22, 23 and
// 39; ADR-0017 and ADR-0021 amendments). The wave-3 checks (deploy announce, harness watches, self-notified
// failures, refusal codes) live in checks-wave3.cjs and run after wave 2; the wave-4 checks (subagent
// background work, hook-time identity, drive grants, the grants read, the coordination panel, Mission
// Control delivery through the inbox) live in checks-wave4.cjs; the wave-5 recovery checks in
// checks-wave5.cjs; the wave-6 epic burndown publish and board read in checks-burndown.cjs; the wave-7
// Mission Control page (the owner board by default, Needs you at ?view=answers) in checks-mission-control-page.cjs;
// the wave-8 question format v2 checks (ADR-0037) in checks-mc-question-v2.cjs; the wave-9 event digest checks
// (ADR-0035) in checks-event-digest.cjs; the wave-10 owner board and pulse (story 12) in checks-board.cjs; the
// wave-11 context lifecycle checks (ADR-0036) in checks-context-lifecycle.cjs; the wave-12 attention alert (story 33:
// one alert per item that becomes owner-visible) in checks-attention-alert.cjs; the wave-13 effect counts (story 15)
// in checks-effects.cjs; the wave-14 local curator (ADR-0038) in checks-curator.cjs, run last.
// Before wave 1, checks-wip-cap.cjs sets the scratch fleet's WIP cap that the fixtures need and proves
// the refusal at the cap (story 20; ADR-0027).
//
//   checks.cjs --state <state.json> [--bash-guard <bash-guard.py>] [--require-bash-guard]
//
// The state file is written by isolated-instance.sh `up`: the candidate directory, the node binary,
// the scratch HOME / TMUX_TMPDIR, the port and the two workspace ids. Every CLI call runs the
// CANDIDATE's installed entry point `bin/purplemux.js` with a clean environment (PATH, HOME,
// TMUX_TMPDIR only), so no token or socket of the live service can leak into a check.
//
// A check that runs "in a tab" types a one-line command into a terminal tab with `tab send` and
// reads the exit code the line writes to a file: the tab's own PMUX_TAB_ID / PMUX_TAB_TOKEN make the
// call, which is the only way to prove per-tab identity (story 01) end to end.
//
// Story 15 (ADR-0018) is proven without a real agent: a `claude-code` tab created with --no-launch
// runs the scratch stand-in `claude --resume <uuid>` (how purplemux finds a tab's transcript), a
// fixture transcript ends the turn, and the Claude hook events (`session-start`, `prompt-submit`,
// `stop`) are posted to /api/status/hook the way the installed hook script posts them. The real
// classifier then decides turn-marker, WAITING or a stop with no end line, and `orchestration status`
// shows the nudge it recorded. A stop with no end line sends no immediate nudge (L49): one
// `idle-no-end-line` nudge follows after the fleet-config window `watchdog.idle-nudge-minutes`,
// which the run sets to IDLE_WINDOW_MIN so the checks need not wait the 15 min default. The
// status poll derives that nudge (every 30–60 s), so the checks wait up to IDLE_WAIT_MS for it.
//
// Wave 2 (story 22) adds: notes delivered to an empty composer and acked (story 10), fleet config
// get/set/unset with its authority and the `constructor` key (story 24), tab close reaping only the
// closed tab's own processes (story 16), the API-error resume and the usage-WARNING negative (story
// 26), an auto-compaction SessionStart that is no turn end (story 32), and dim-suggestion marking in
// `tab result` (story 17).
//
// Output: one line per check — `PASS <id> — <what>`, `FAIL <id> — <what> — measured: … — expected: …`
// or `SKIP <id> — <why>` — then `ACCEPTANCE=PASS|FAIL checks=N passed=P failed=F skipped=S`.
// Exit 0 only when nothing failed (and, with --require-bash-guard, nothing was skipped).

'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { wave3 } = require('./checks-wave3.cjs');
const { wave4, request, humanSession, liveStandIn, standInRecord } = require('./checks-wave4.cjs');
const { wave5 } = require('./checks-wave5.cjs');
const { wave6 } = require('./checks-burndown.cjs');
const { wave7 } = require('./checks-mission-control-page.cjs');
const { wave8 } = require('./checks-mc-question-v2.cjs');
const { wave9 } = require('./checks-event-digest.cjs');
const { wave10 } = require('./checks-board.cjs');
const { wave11 } = require('./checks-context-lifecycle.cjs');
const { waveAttentionAlert } = require('./checks-attention-alert.cjs');
const { wave13 } = require('./checks-effects.cjs');
const { wave14 } = require('./checks-curator.cjs');
const { wave15 } = require('./checks-curator-routing.cjs');
const { fixtureCapGate } = require('./checks-wip-cap.cjs');

const POLL_MS = 200;
/** The idle window the run sets (fleet config, minutes): 3 s. */
const IDLE_WINDOW_MIN = '0.05';
const IDLE_WINDOW_MS = 3000;
/** The window plus two status polls of the largest interval. */
const IDLE_WAIT_MS = 130000;
const FIXTURE_PROCESS_WAIT_MS = 10000;
const FIXTURE_BIND_WAIT_MS = 150000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Judge the SC-1 race: exactly one acquire wins (0) and the other is refused (3) naming the winner. */
const judgeRace = (a, b, idA, idB) => {
  const winners = [a, b].filter((r) => r.rc === 0).length;
  const losers = [a, b].filter((r) => r.rc === 3);
  if (winners !== 1 || losers.length !== 1) {
    return { ok: false, measured: `exit codes ${a.rc} and ${b.rc}`, expected: 'exactly one 0 and one 3' };
  }
  const winnerId = a.rc === 0 ? idA : idB;
  const loser = a.rc === 3 ? a : b;
  const named = `${loser.out}\n${loser.err}`.includes(winnerId);
  return named
    ? { ok: true, winnerId, loserId: winnerId === idA ? idB : idA }
    : { ok: false, measured: `the refusal does not name ${winnerId}: ${loser.err.trim().slice(0, 200)}`, expected: 'the holder named' };
};

/**
 * Judge a note delivery (story 10): the server stamped `deliveredAt` (the inbox delivered the line, not
 * just queued it), the recipient's composer received the fixed notice line naming the note, and the
 * body never reached it. `input` is what the recipient's stand-in read from its terminal.
 */
const judgeNoteDelivery = (note, input, bodyMarker) => {
  const stamped = typeof note?.deliveredAt === 'number';
  const noticed = Boolean(note?.id) && input.includes(`[purplemux note ${note.id}]`);
  const bodyTyped = input.includes(bodyMarker);
  return {
    ok: stamped && noticed && !bodyTyped,
    measured: `deliveredAt ${JSON.stringify(note?.deliveredAt ?? null)}, notice line received ${noticed}, body typed ${bodyTyped}`,
  };
};

/** Aggregate check results into the report lines and the verdict. */
const summarize = (results, { requireBashGuard = false } = {}) => {
  const lines = results.map((r) => {
    if (r.status === 'pass') return `PASS ${r.id} — ${r.what}`;
    if (r.status === 'skip') return `SKIP ${r.id} — ${r.why}`;
    return `FAIL ${r.id} — ${r.what} — measured: ${r.measured} — expected: ${r.expected}`;
  });
  const count = (s) => results.filter((r) => r.status === s).length;
  const failed = count('fail');
  const skipped = count('skip');
  const guardSkipped = results.some((r) => r.status === 'skip' && r.id === 'bash-guard');
  // The WIP cap gate's own results (`gate: true`) never make a run pass: a run that ran no wave did not run.
  const pass = failed === 0 && results.some((r) => !r.gate) && !(requireBashGuard && guardSkipped);
  lines.push(`ACCEPTANCE=${pass ? 'PASS' : 'FAIL'} checks=${results.length} passed=${count('pass')} failed=${failed} skipped=${skipped}`);
  return { lines, pass };
};

class Instance {
  constructor(state) {
    this.state = state;
    this.cliPath = path.join(state.candidate, 'bin', 'purplemux.js');
    this.env = { PATH: `${path.dirname(state.node)}:/usr/bin:/bin`, HOME: state.home, TMUX_TMPDIR: state.tmuxTmpdir };
    this.fixtureAgents = new Map();
    this.shellOperations = new Map();
    this.fixtureEvidenceDir = state.evidenceDir || path.join(state.scratch, 'evidence');
    fs.mkdirSync(this.fixtureEvidenceDir, { recursive: true });
  }

  persistFixtureObservation(kind, details) {
    const observedAt = Date.now();
    const record = { observedAt, kind, ...details };
    const name = `${String(observedAt)}-${kind.replace(/[^a-zA-Z0-9_-]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.json`;
    const file = path.join(this.fixtureEvidenceDir, name);
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    fs.appendFileSync(path.join(this.fixtureEvidenceDir, 'observations.jsonl'), `${JSON.stringify({ ...record, file })}\n`);
    return file;
  }

  /** Run the actual unscoped shell CLI; its production token selection supplies workspace scope. */
  cli(args, { env = this.env, timeoutMs = 30000 } = {}) {
    return run(this.state.node, [this.cliPath, ...args], { env, timeoutMs });
  }

  /** The scratch human session's cookie (`session-token=...`); throws with the reason when none is issued. */
  async humanCookie() {
    const password = `acc-pw-${crypto.createHash('sha256').update(this.state.scratch).digest('hex').slice(0, 16)}`;
    const session = await humanSession(this.state.port, password);
    if (!session.cookie) throw new Error(session.why);
    return session.cookie;
  }

  async human(method, endpoint, body) {
    const cookie = await this.humanCookie();
    return request(this.state.port, method, endpoint, { body, headers: { cookie, origin: `http://localhost:${this.state.port}` } });
  }

  /** Intentional fixture ownership changes use the same displayed-revision human replacement as the UI. */
  async designate(ws, tabId) {
    const current = parseJson((await this.cli(['orchestration', 'status', '-w', ws])).out)?.orchestration;
    const result = await this.human('PATCH', `/api/workspace/${ws}`, { orchestration: {
      enabled: true, orchestratorTabId: tabId,
    }, expectedRevision: current?.revision, mode: 'replace' });
    return { rc: result.status === 200 ? 0 : 1, out: result.body, err: result.status === 200 ? '' : result.body };
  }

  async startFixtureAgent(ws, tab, options = {}) {
    if (!tab) return { rc: -1, out: '', err: 'missing fixture agent' };
    const started = await this.startStandIn(tab.sessionName, 'Ready.', {
      workspaceDir: ws === this.state.workspaces.a ? 'a' : 'b', ...options,
    });
    if (started.rc !== 0) return started;
    await sleep(1000);
    await this.hook('session-start', tab.sessionName);
    return started;
  }

  async observeFixtureAgent(ws, tab, expected) {
    const result = await this.cli(['tab', 'status', '-w', ws, tab.tabId]);
    const status = parseJson(result.out);
    const panePid = await this.isolatedPanePid(tab.sessionName);
    const pane = processIdentity(panePid);
    const record = standInRecord(this.state.home, expected?.sessionId);
    const process = processIdentity(record?.pid);
    const descendant = Boolean(panePid && process && processDescendsFrom(process.pid, panePid));
    return assessFixtureAgent({ result, status, panePid, pane, record, process, expected, descendant });
  }

  async startLiveFixtureAgent(ws, tab, { inputFile = null, phase = 'launch' } = {}) {
    if (!tab) return { rc: -1, out: '', err: 'missing fixture agent' };
    const launchedAfter = Date.now();
    const started = await this.startStandIn(tab.sessionName, 'Ready.', {
      workspaceDir: ws === this.state.workspaces.a ? 'a' : 'b', inputFile,
      standInPath: liveStandIn(this.state.scratch), verifiedShell: true,
    });
    if (started.rc !== 0) return started;
    const sessionId = path.basename(started.transcriptPath, '.jsonl');
    const processReady = await pollObservation(FIXTURE_PROCESS_WAIT_MS, async () => fixturePhysicalObservation(
      await this.observeFixtureAgent(ws, tab, { sessionId, launchedAfter }),
    ));
    const processEvidence = this.persistFixtureObservation(`${phase}-physical`, {
      workspaceId: ws, tabId: tab.tabId, sessionName: tab.sessionName, sessionId, launchedAfter,
      shellOperation: started.operation ?? null, observation: processReady,
    });
    if (!processReady.ok) {
      return { ...started, rc: -1, err: `live fixture process was not observed; evidence ${processEvidence}`, observation: processReady, evidence: [processEvidence] };
    }
    const pinned = {
      sessionId,
      pid: processReady.facts.record.pid,
      startedAt: processReady.facts.record.startedAt,
      startTicks: processReady.facts.process.startTicks,
    };
    await this.hook('session-start', tab.sessionName);
    const observation = await pollObservation(FIXTURE_BIND_WAIT_MS, () => this.observeFixtureAgent(ws, tab, pinned));
    const bindingEvidence = this.persistFixtureObservation(`${phase}-binding`, {
      workspaceId: ws, tabId: tab.tabId, sessionName: tab.sessionName, pinned, observation,
    });
    if (!observation.ok || !observation.identity) {
      return { ...started, rc: -1, err: `live fixture was not bound; evidence ${bindingEvidence}`, observation, evidence: [processEvidence, bindingEvidence] };
    }
    this.fixtureAgents.set(tab.tabId, observation.identity);
    return { ...started, observation, evidence: [processEvidence, bindingEvidence] };
  }

  async restoreLiveFixtureAgent(ws, tab) {
    return this.startLiveFixtureAgent(ws, tab, { phase: 'restore' });
  }

  async isolatedShellState(session) {
    const shown = await this.isolatedTmux(['display-message', '-p', '-t', session, '#{pane_current_command}']);
    const panePid = await this.isolatedPanePid(session);
    const process = processIdentity(panePid);
    return assessShellControl({ result: shown, command: shown.out.trim(), panePid, process });
  }

  shellReceipt(operation) {
    const text = readIf(operation.receiptPath);
    if (text === null || text.trim() === '' || !/^-?\d+$/.test(text.trim())) return null;
    return Number(text.trim());
  }

  async captureIsolatedPane(session) {
    const captured = await this.isolatedTmux(['capture-pane', '-p', '-S', '-200', '-t', session]);
    return captured.out;
  }

  async isolatedShellCommand(session, command, { timeoutMs = 30000, waitForCompletion = true, terminalOutput = false } = {}) {
    const previous = this.shellOperations.get(session) ?? null;
    if (previous && this.shellReceipt(previous) === null) {
      await within(3000, async () => this.shellReceipt(previous) !== null);
      if (this.shellReceipt(previous) === null) {
        const partial = await this.captureIsolatedPane(session);
        const evidence = this.persistFixtureObservation('shell-refused-ambiguous', { sessionName: session, previous, partial });
        return { rc: -1, out: '', err: `previous isolated shell operation has no receipt; not resent; evidence ${evidence}`, operation: previous };
      }
    }

    const shell = await this.isolatedShellState(session);
    const shellEvidence = this.persistFixtureObservation('shell-control', { sessionName: session, observation: shell });
    if (!shell.ok) return { rc: -1, out: '', err: `foreground shell not proven; evidence ${shellEvidence}`, shell };

    const tag = crypto.randomBytes(4).toString('hex');
    const base = path.join(this.state.scratch, 'io', `shell-${tag}`);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const operation = {
      sessionName: session,
      commandStartPath: `${base}.started`,
      receiptPath: `${base}.rc`,
      stdoutPath: `${base}.out`,
      stderrPath: `${base}.err`,
    };
    const invoke = terminalOutput
      ? `: > ${shellQuote(operation.commandStartPath)}; /bin/bash -c ${shellQuote(`exec -a claude /bin/bash ${shellQuote(this.fixtureCommandWrapper())} ${shellQuote(operation.receiptPath)} ${shellQuote(command)}`)}`
      : `: > ${shellQuote(operation.commandStartPath)}; ( ${command} ) > ${shellQuote(operation.stdoutPath)} 2> ${shellQuote(operation.stderrPath)}; rc=$?; printf '%s\\n' "$rc" > ${shellQuote(operation.receiptPath)}`;
    const sent = await this.keys(session, invoke, { clearPending: true });
    if (sent.rc !== 0) return { rc: -1, out: '', err: `isolated tmux send exited ${sent.rc}: ${sent.err.trim()}`, operation };
    this.shellOperations.set(session, operation);
    const started = await within(3000, async () => fs.existsSync(operation.commandStartPath));
    if (!started) {
      const partial = await this.captureIsolatedPane(session);
      const evidence = this.persistFixtureObservation('shell-start-timeout', { sessionName: session, operation, sent, partial });
      return { rc: -1, out: readIf(operation.stdoutPath) || '', err: `command-start marker absent; mutation state ambiguous; not resent; evidence ${evidence}`, operation, partial };
    }
    if (!waitForCompletion) {
      const evidence = this.persistFixtureObservation('shell-command-started', { sessionName: session, operation, shell });
      return { rc: 0, out: '', err: '', operation, evidence };
    }

    const completed = await within(timeoutMs, async () => {
      const rc = this.shellReceipt(operation);
      return rc === null ? null : { rc };
    });
    if (!completed) {
      const partial = await this.captureIsolatedPane(session);
      const evidence = this.persistFixtureObservation('shell-receipt-timeout', { sessionName: session, operation, partial });
      return {
        rc: -1,
        out: readIf(operation.stdoutPath) || '',
        err: `${readIf(operation.stderrPath) || ''}no exit receipt within ${timeoutMs} ms; mutation state ambiguous; not resent; evidence ${evidence}`,
        operation,
        partial,
      };
    }
    const result = { rc: completed.rc, out: readIf(operation.stdoutPath) || '', err: readIf(operation.stderrPath) || '', operation };
    result.evidence = this.persistFixtureObservation('shell-command-complete', { sessionName: session, operation, result: { rc: result.rc, out: result.out, err: result.err } });
    return result;
  }

  /** Type `command` into a terminal tab; wait for the exit code it writes. */
  async inTab(ws, tab, command, { timeoutMs = 30000, session = null } = {}) {
    if (session) return this.isolatedShellCommand(session, command, { timeoutMs });
    const tag = crypto.randomBytes(4).toString('hex');
    const base = path.join(this.state.scratch, 'io', `${tab}-${tag}`);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const line = `( ${command} ) > ${base}.out 2> ${base}.err; echo $? > ${base}.rc`;
    // A stopped agent stand-in leaves a shell that agent-readiness intentionally refuses.
    // Only isolated fixture panes use keys(); their original injected identity is unchanged.
    const sent = await this.cli(['tab', 'send', '-w', ws, tab, line]);
    if (sent.rc !== 0) return { rc: -1, out: '', err: `tab send exited ${sent.rc}: ${sent.err.trim()}` };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rcText = readIf(`${base}.rc`);
      if (rcText !== null && rcText.trim() !== '') {
        return { rc: Number(rcText.trim()), out: readIf(`${base}.out`) || '', err: readIf(`${base}.err`) || '' };
      }
      await sleep(POLL_MS);
    }
    return { rc: -1, out: '', err: `no exit code within ${timeoutMs} ms` };
  }

  /** POST a Claude hook event for a tab's tmux session, as the installed hook script does. */
  hook(event, session, extra = {}) {
    const token = fs.readFileSync(path.join(this.state.home, '.purplemux', 'cli-token'), 'utf8').trim();
    const body = JSON.stringify({ event, session, ...extra });
    return new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: this.state.port, path: '/api/status/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pmux-token': token, 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', () => resolve(0));
      req.end(body);
    });
  }

  /**
   * Start a scratch `claude` stand-in in an agent tab's pane, over the ISOLATED tmux socket only.
   * `transcript` is the last assistant text, or the transcript's entries as objects. `workspaceDir`
   * is the pane's cwd under scratch/work (a/ or b/); `composer` runs the stand-in that draws an
   * empty Claude composer and swallows its input unechoed, so the inbox can deliver to it.
   * `subagents` maps a subagent file name (`agent-<id>.jsonl`) to its entries, written under
   * `<transcript>/subagents/` as Claude writes them (story 37). The result carries `transcriptPath`
   * so a check can append to the transcript later. `standInPath` runs another stand-in script.
   */
  async startStandIn(session, transcript, {
    workspaceDir = 'b', composer = false, inputFile = null, subagents = null,
    standInPath = null, background = false, verifiedShell = false,
  } = {}) {
    const tmuxDir = this.state.tmuxTmpdir;
    if (!tmuxDir.startsWith(`${this.state.scratch}/`)) throw new Error(`tmux dir ${tmuxDir} is not under the scratch directory`);
    const uuid = crypto.randomUUID();
    const cwd = path.join(this.state.scratch, 'work', workspaceDir);
    const project = path.join(this.state.home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(project, { recursive: true });
    const lines = Array.isArray(transcript)
      ? transcript
      : [
        { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'go' } },
        { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: transcript }] } },
      ];
    const transcriptPath = path.join(project, `${uuid}.jsonl`);
    fs.writeFileSync(transcriptPath, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    if (subagents) {
      const dir = path.join(project, uuid, 'subagents');
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, entries] of Object.entries(subagents)) {
        fs.writeFileSync(path.join(dir, name), `${entries.map((l) => JSON.stringify(l)).join('\n')}\n`);
      }
    }
    const env = { PATH: '/usr/bin:/bin', TMUX_TMPDIR: tmuxDir };
    const standIn = standInPath ?? (composer ? this.composerStandIn() : path.join(this.state.scratch, 'bin', 'claude'));
    const input = inputFile ? `ACC_INPUT=${shellQuote(inputFile)} ` : '';
    const command = `${input}${standIn} --resume ${uuid}${background ? " </dev/null >/dev/null 2>&1 &" : ""}`;
    const started = verifiedShell
      ? await this.isolatedShellCommand(session, command, { timeoutMs: 10000, waitForCompletion: background, terminalOutput: !background })
      : await run('tmux', ['-L', 'purple', 'send-keys', '-t', session, command, 'Enter'], { env, timeoutMs: 10000 });
    return { ...started, transcriptPath };
  }

  /**
   * A second stand-in, also named `claude`: it draws an empty composer and reads its input unechoed
   * into $ACC_INPUT, so a check can prove what was typed into the "composer" without it showing.
   */
  composerStandIn() {
    const file = path.join(this.state.scratch, 'bin', 'composer', 'claude');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Drawn on the pane's last rows, as Claude draws it: readiness reads the tail of the pane.
      fs.writeFileSync(file, [
        '#!/bin/sh',
        'clear',
        'rows=$(stty size 2>/dev/null | cut -d" " -f1)',
        'i=4; while [ "$i" -lt "${rows:-24}" ]; do echo; i=$((i + 1)); done',
        "printf '────────────────\\n\\342\\235\\257 \\n────────────────'",
        'stty -echo 2>/dev/null',
        'cat >>"${ACC_INPUT:-/dev/null}"',
        '',
      ].join('\n'));
      fs.chmodSync(file, 0o755);
    }
    return file;
  }

  /** Keep a receipt-writing parent in the foreground process group when Ctrl-C ends a live stand-in. */
  fixtureCommandWrapper() {
    const file = path.join(this.state.scratch, 'bin', 'fixture-command-wrapper');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, [
        '#!/bin/bash',
        'receipt="$1"; command="$2"',
        'finish() { rc="$1"; printf \'%s\\n\' "$rc" > "$receipt"; trap - INT TERM; exit "$rc"; }',
        'trap \'finish 130\' INT',
        'trap \'finish 143\' TERM',
        '/bin/bash -c "$command"',
        'finish "$?"',
        '',
      ].join('\n'));
      fs.chmodSync(file, 0o755);
    }
    return file;
  }

  /** Type keys into a pane over the ISOLATED tmux socket (for a pane whose shell `tab send` refuses). */
  keys(session, line, { clearPending = false } = {}) {
    const tmuxDir = this.state.tmuxTmpdir;
    if (!tmuxDir.startsWith(`${this.state.scratch}/`)) throw new Error(`tmux dir ${tmuxDir} is not under the scratch directory`);
    const keys = clearPending ? ['C-u', line, 'Enter'] : [line, 'Enter'];
    return run('tmux', ['-L', 'purple', 'send-keys', '-t', session, ...keys], { env: { PATH: '/usr/bin:/bin', TMUX_TMPDIR: tmuxDir }, timeoutMs: 10000 });
  }

  /** Put literal text on an isolated shell's pending Readline buffer without executing it. */
  preloadPendingInput(session, text) {
    const tmuxDir = this.state.tmuxTmpdir;
    if (!tmuxDir.startsWith(`${this.state.scratch}/`)) throw new Error(`tmux dir ${tmuxDir} is not under the scratch directory`);
    return run('tmux', ['-L', 'purple', 'send-keys', '-l', '-t', session, text], { env: { PATH: '/usr/bin:/bin', TMUX_TMPDIR: tmuxDir }, timeoutMs: 10000 });
  }

  /** Exact probes and lifecycle operations against only this fixture's isolated tmux server. */
  isolatedTmux(args) {
    const tmuxDir = this.state.tmuxTmpdir;
    if (!tmuxDir.startsWith(`${this.state.scratch}/`)) throw new Error(`tmux dir ${tmuxDir} is not under the scratch directory`);
    return run('tmux', ['-L', 'purple', ...args], { env: { PATH: '/usr/bin:/bin', TMUX_TMPDIR: tmuxDir }, timeoutMs: 10000 });
  }

  removeIsolatedSession(session) {
    return this.isolatedTmux(['kill-session', '-t', session]);
  }

  async isolatedSessionExists(session) {
    return (await this.isolatedTmux(['has-session', '-t', session])).rc === 0;
  }

  async isolatedPanePid(session) {
    const result = await this.isolatedTmux(['display-message', '-p', '-t', session, '#{pane_pid}']);
    const pid = Number(result.out.trim());
    return result.rc === 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  }

  strictSessionProbe(session) {
    return this.isolatedTmux(['list-panes', '-t', `=${session}`, '-F', '#{session_name}\t#{pane_id}\t#{pane_pid}']);
  }

  async inbox(ws) {
    return parseJson((await this.cli(['inbox', 'list', '-w', ws, '--all'])).out)?.items ?? [];
  }

  async nudgesFor(ws, tabId) {
    const r = await this.cli(['orchestration', 'status', '-w', ws]);
    return (parseJson(r.out)?.nudges || []).filter((n) => n.tabId === tabId);
  }

  async cliState(ws, tabId) {
    return parseJson((await this.cli(['tab', 'status', '-w', ws, tabId])).out)?.cliState ?? null;
  }

  async fixtureAgentState(ws, tab) {
    const expected = this.fixtureAgents.get(tab.tabId);
    if (!expected) {
      return { ok: false, result: { rc: -1, out: '', err: 'no captured live fixture identity' }, status: null, facts: null };
    }
    return this.observeFixtureAgent(ws, tab, expected);
  }

  /** The candidate CLI as a one-line shell command, for use inside a tab (whose PATH has no node). */
  tabCli(args) {
    return [this.state.node, this.cliPath, ...args].map(shellQuote).join(' ');
  }
}

const readIf = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const processIdentity = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    const argv0 = path.basename((fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] || ''));
    const identity = {
      pid,
      state: fields[0],
      ppid: Number(fields[1]),
      pgrp: Number(fields[2]),
      tpgid: Number(fields[5]),
      startTicks: Number(fields[19]),
      argv0,
    };
    return Number.isSafeInteger(identity.ppid) && Number.isSafeInteger(identity.pgrp)
      && Number.isSafeInteger(identity.tpgid) && Number.isSafeInteger(identity.startTicks) ? identity : null;
  } catch {
    return null;
  }
};

const processDescendsFrom = (pid, ancestorPid) => {
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ancestorPid)) return false;
  const seen = new Set();
  let current = pid;
  while (current > 1 && !seen.has(current)) {
    if (current === ancestorPid) return true;
    seen.add(current);
    current = processIdentity(current)?.ppid ?? 0;
  }
  return false;
};

const assessFixtureAgent = ({ result, status, panePid, pane, record, process, expected, descendant }) => {
  const freshRecord = Boolean(record && Number.isFinite(record.startedAt)
    && (!expected?.launchedAfter || record.startedAt >= expected.launchedAfter - 1000));
  const sameIdentity = Boolean(record && process
    && (!expected?.pid || record.pid === expected.pid)
    && (!expected?.startedAt || record.startedAt === expected.startedAt)
    && (!expected?.startTicks || process.startTicks === expected.startTicks));
  const foreground = Boolean(pane && process && pane.tpgid > 0 && process.pgrp === pane.tpgid);
  const bound = status?.agentSessionId === expected?.sessionId;
  const predicates = {
    statusRead: result.rc === 0,
    alive: status?.alive === true,
    command: status?.command === 'claude',
    provider: status?.agentProviderId === 'claude',
    bound,
    freshRecord,
    sameIdentity,
    nonZombie: Boolean(process && process.state !== 'Z'),
    argv0: process?.argv0 === 'claude',
    descendant,
    foreground,
  };
  const failedPredicates = Object.entries(predicates).filter(([, value]) => !value).map(([name]) => name);
  const ok = failedPredicates.length === 0;
  return {
    ok,
    result,
    status,
    facts: {
      panePid,
      record: record ? { pid: record.pid, sessionId: record.sessionId, startedAt: record.startedAt } : null,
      process,
      freshRecord,
      sameIdentity,
      descendant,
      foreground,
      bound,
      predicates,
      failedPredicates,
    },
    identity: ok ? {
      sessionId: record.sessionId,
      pid: record.pid,
      startedAt: record.startedAt,
      startTicks: process.startTicks,
    } : null,
  };
};

const fixturePhysicalObservation = (observation) => {
  const required = ['freshRecord', 'sameIdentity', 'nonZombie', 'argv0', 'descendant', 'foreground'];
  const failedPredicates = required.filter((name) => !observation.facts?.predicates?.[name]);
  return {
    ...observation,
    ok: failedPredicates.length === 0,
    facts: { ...observation.facts, physicalFailedPredicates: failedPredicates },
  };
};

const assessShellControl = ({ result, command, panePid, process }) => {
  const predicates = {
    statusRead: result.rc === 0,
    shellCommand: ['bash', 'sh', 'zsh', 'fish'].includes(command),
    processReadable: Boolean(process),
    nonZombie: Boolean(process && process.state !== 'Z'),
    foreground: Boolean(process && process.tpgid > 0 && process.pgrp === process.tpgid),
  };
  return {
    ok: Object.values(predicates).every(Boolean),
    result,
    command,
    panePid,
    process,
    predicates,
    failedPredicates: Object.entries(predicates).filter(([, value]) => !value).map(([name]) => name),
  };
};

const shellQuote = (s) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

const run = (bin, args, { env, timeoutMs }) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ rc: code === null ? -1 : code, out, err: signal ? `${err}\nkilled by ${signal}` : err });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ rc: -1, out, err: String(e) });
    });
  });

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const completeResult = (result, fallback = 'incomplete operation result') => ({
  ...(result && typeof result === 'object' ? result : {}),
  rc: Number.isInteger(result?.rc) ? result.rc : -1,
  out: typeof result?.out === 'string' ? result.out : '',
  err: typeof result?.err === 'string' ? result.err : fallback,
});

const brief = (result) => {
  const r = completeResult(result);
  return `exit ${r.rc}${r.err.trim() ? `, stderr: ${r.err.trim().split('\n')[0].slice(0, 160)}` : ''}`;
};

/** Preserve the actual designated scratch coordinator while removing only the other fixture tabs. */
const retainDesignatedFixture = async (inst, ws, candidates, { restore = null } = {}) => {
  const tabs = candidates.filter((tab) => tab?.tabId);
  const beforeResult = await inst.cli(['orchestration', 'status', '-w', ws]);
  const before = parseJson(beforeResult.out)?.orchestration;
  const retained = tabs.find((tab) => tab.tabId === before?.orchestratorTabId) ?? null;
  if (beforeResult.rc !== 0 || before?.enabled !== true || typeof before.orchestratorTabId !== 'string'
    || !Number.isSafeInteger(before.revision) || before.revision < 0 || !retained) {
    return {
      ok: false,
      measured: `mapping ${brief(beforeResult)} ${JSON.stringify(before ?? null)}; candidates ${tabs.map((tab) => tab.tabId).join(',') || 'none'}`,
      retained: null,
      closed: [],
    };
  }

  let live = await inst.fixtureAgentState(ws, retained);
  let restored = null;
  if (!live.ok && restore) {
    restored = await restore(retained);
    if (restored?.rc === 0) live = await pollObservation(10000, () => inst.fixtureAgentState(ws, retained));
  }
  if (!live.ok) {
    return {
      ok: false,
      measured: `designated ${retained.tabId} not live: ${brief(live.result)} status ${JSON.stringify(live.status ?? null)} facts ${JSON.stringify(live.facts ?? null)}; restore ${restored ? brief(restored) : 'not attempted'}`,
      retained: retained.tabId,
      closed: [],
    };
  }

  const closed = [];
  for (const tab of tabs) {
    if (tab.tabId === retained.tabId) continue;
    const result = await inst.cli(['tab', 'close', '-w', ws, tab.tabId]);
    closed.push({ tabId: tab.tabId, result, ok: result.rc === 0 && result.out.trim().split('\n')[0] === 'ok' });
  }
  const afterResult = await inst.cli(['orchestration', 'status', '-w', ws]);
  const after = parseJson(afterResult.out)?.orchestration;
  const finalLive = await pollObservation(5000, () => inst.fixtureAgentState(ws, retained));
  const mappingUnchanged = afterResult.rc === 0 && before.enabled === after?.enabled
    && before.orchestratorTabId === after?.orchestratorTabId && before.revision === after?.revision;
  const ok = closed.every((entry) => entry.ok) && mappingUnchanged && finalLive.ok;
  return {
    ok,
    measured: `retained ${retained.tabId} live ${finalLive.ok} facts ${JSON.stringify(finalLive.facts ?? null)}; restored ${restored ? brief(restored) : 'not needed'}; closes ${closed.map((entry) => `${entry.tabId}:${brief(entry.result)}:${JSON.stringify(entry.result.out.trim().split('\n')[0] ?? '')}`).join(',') || 'none'}; mapping ${JSON.stringify(before)} -> ${JSON.stringify(after ?? null)}`,
    retained: retained.tabId,
    closed,
  };
};

/** The wave-1 checks. Each pushes one result; a failed prerequisite fails what depends on it. */
const wave1 = async (inst, { bashGuard }) => {
  const results = [];
  const nonce = crypto.randomBytes(3).toString('hex');
  const { a: wsA, b: wsB } = inst.state.workspaces;
  const pass = (id, what) => results.push({ status: 'pass', id, what });
  const fail = (id, what, measured, expected) => results.push({ status: 'fail', id, what, measured, expected });
  const skip = (id, why) => results.push({ status: 'skip', id, why });
  const check = (id, what, ok, measured, expected) => (ok ? pass(id, what) : fail(id, what, measured, expected));

  // ---- tabs: create / list / send / result / status
  const tabs = {};
  for (const [key, ws] of [['A1', wsA], ['A2', wsA], ['B1', wsB]]) {
    const r = await inst.cli(['tab', 'create', '-w', ws, '-n', `acc-${key.toLowerCase()}`, '-t', 'terminal']);
    const body = parseJson(r.out);
    if (r.rc === 0 && body && body.tabId && body.panelType === 'terminal') tabs[key] = body.tabId;
  }
  const haveTabs = Boolean(tabs.A1 && tabs.A2 && tabs.B1);
  check('tab-create', 'three terminal tabs created in two workspaces', haveTabs, JSON.stringify(tabs), 'tab ids for A1, A2, B1');
  if (!haveTabs) return results;
  await sleep(1000);

  const list = await inst.cli(['tab', 'list', '-w', wsA]);
  const listed = list.rc === 0 && list.out.includes(tabs.A1) && list.out.includes(tabs.A2) && !list.out.includes(tabs.B1);
  check('tab-list', 'tab list -w A shows A1 and A2 and not B1', listed, brief(list), 'exit 0 with exactly the workspace-A tabs');

  const marker = `ACC-$((6*7))-${nonce}`;
  const sent = await inst.cli(['tab', 'send', '-w', wsA, tabs.A1, `echo ${marker}`]);
  let seen = false;
  for (let i = 0; i < 50 && !seen && sent.rc === 0; i++) {
    const res = await inst.cli(['tab', 'result', '-w', wsA, tabs.A1]);
    seen = res.rc === 0 && res.out.includes(`ACC-42-${nonce}`);
    if (!seen) await sleep(POLL_MS);
  }
  check('tab-send-result', 'tab send runs a line and tab result shows its output', seen, `send ${brief(sent)}; output seen: ${seen}`, `ACC-42-${nonce} in the pane`);

  const status = await inst.cli(['tab', 'status', '-w', wsA, tabs.A1]);
  check('tab-status', 'tab status answers for a live tab', status.rc === 0 && status.out.includes(tabs.A1), brief(status), `exit 0 naming ${tabs.A1}`);

  // ---- caller identity (story 01)
  const env = await inst.inTab(wsA, tabs.A1, 'printf "%s" "$PMUX_TAB_ID"; test -n "$PMUX_TAB_TOKEN"');
  check('identity-env', 'a tab carries PMUX_TAB_ID and PMUX_TAB_TOKEN', env.rc === 0 && env.out === tabs.A1, `exit ${env.rc}, PMUX_TAB_ID=${env.out}`, `exit 0, PMUX_TAB_ID=${tabs.A1}`);

  // ---- a tab from before story 01 (every live tab at the first deploy): only the workspace token,
  // the tab named by its tmux session. Its lease writes must still work, unverified (ADR-0010).
  const legacyName = `acc:legacy-${nonce}`;
  const legacy = await inst.inTab(wsA, tabs.A1, `env -u PMUX_TAB_TOKEN -u PMUX_TAB_ID ${inst.tabCli(['lease', 'acquire', legacyName, '--ttl', '5m'])}`);
  const legacyLease = (parseJson((await inst.cli(['lease', 'list', '--json'])).out)?.leases || []).find((l) => l.name === legacyName);
  await inst.cli(['lease', 'break', legacyName, '--reason', 'acceptance cleanup']);
  check(
    'legacy-tab-identity',
    'a tab without PMUX_TAB_TOKEN (pre-story-01) still takes a lease, as an unverified holder named by its session',
    legacy.rc === 0 && legacyLease?.holder.tabId === tabs.A1 && legacyLease?.holder.verified === false,
    `exit ${legacy.rc} (${legacy.err.trim().split('\n')[0] || 'no message'}), holder ${JSON.stringify(legacyLease?.holder || null)}`,
    `exit 0, holder.tabId=${tabs.A1}, verified=false`,
  );

  // ---- leases (stories 03, 27): the SC-1 race across two workspaces
  const race = `merge:acc/race-${nonce}`;
  const [ra, rb] = await Promise.all([
    inst.inTab(wsA, tabs.A1, inst.tabCli(['lease', 'acquire', race, '--ttl', '5m'])),
    inst.inTab(wsB, tabs.B1, inst.tabCli(['lease', 'acquire', race, '--ttl', '5m'])),
  ]);
  const judged = judgeRace(ra, rb, tabs.A1, tabs.B1);
  check('lease-race', 'two tabs in two workspaces race one merge lease: one wins, one is refused naming the holder', judged.ok, judged.measured, judged.expected);
  if (judged.ok) {
    const winnerWs = judged.winnerId === tabs.A1 ? wsA : wsB;
    const loserWs = winnerWs === wsA ? wsB : wsA;
    const listing = await inst.cli(['lease', 'list', '--json']);
    const lease = (parseJson(listing.out)?.leases || []).find((l) => l.name === race);
    check(
      'lease-verified',
      'lease list shows the winning tab as a verified holder',
      Boolean(lease && lease.holder.tabId === judged.winnerId && lease.holder.verified === true),
      JSON.stringify(lease?.holder || null),
      `holder.tabId=${judged.winnerId}, verified=true`,
    );
    const renew = await inst.inTab(winnerWs, judged.winnerId, inst.tabCli(['lease', 'renew', race, '--ttl', '10m']));
    const stolen = await inst.inTab(loserWs, judged.loserId, inst.tabCli(['lease', 'release', race]));
    const released = await inst.inTab(winnerWs, judged.winnerId, inst.tabCli(['lease', 'release', race]));
    const after = await inst.cli(['lease', 'check', race]);
    check(
      'lease-renew-release',
      'the holder renews and releases; another tab cannot release it',
      renew.rc === 0 && stolen.rc === 3 && released.rc === 0 && after.rc === 7,
      `renew ${renew.rc}, release by other ${stolen.rc}, release by holder ${released.rc}, check after ${after.rc}`,
      'renew 0, release by other 3, release by holder 0, check after 7',
    );
  } else {
    fail('lease-verified', 'lease list shows the winning tab as a verified holder', 'no winner', 'the race decided first');
    fail('lease-renew-release', 'the holder renews and releases', 'no winner', 'the race decided first');
  }

  const ttlName = `acc:ttl-${nonce}`;
  const short = await inst.inTab(wsA, tabs.A1, inst.tabCli(['lease', 'acquire', ttlName, '--ttl', '2s']));
  let expired = false;
  for (let i = 0; i < 60 && !expired && short.rc === 0; i++) {
    await sleep(250);
    expired = (await inst.cli(['lease', 'check', ttlName])).rc === 7;
  }
  check('lease-expiry', 'a 2 s lease is gone within 15 s', short.rc === 0 && expired, `acquire ${short.rc}, expired ${expired}`, 'acquire 0, then lease check exit 7');

  // ---- bash-guard (engineering story 04) against the candidate CLI, from inside the tabs
  if (!bashGuard) {
    skip('bash-guard', 'no --bash-guard path given');
  } else {
    const repo = `acc/guard-${nonce}`;
    const wrapper = path.join(inst.state.scratch, 'bin', 'purplemux');
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(inst.state.node)} ${shellQuote(inst.cliPath)} "$@"\n`, { mode: 0o755 });
    const payload = path.join(inst.state.scratch, `guard-${nonce}.json`);
    fs.writeFileSync(payload, JSON.stringify({ tool_input: { command: `gh pr merge 1 --repo ${repo} --squash` }, cwd: inst.state.scratch }));
    const guard = `BASH_GUARD_PURPLEMUX=${shellQuote(wrapper)} python3 ${shellQuote(bashGuard)} < ${shellQuote(payload)}`;
    const held = await inst.inTab(wsA, tabs.A1, inst.tabCli(['lease', 'acquire', `merge:${repo}`, '--ttl', '5m']));
    const allowed = await inst.inTab(wsA, tabs.A1, guard);
    const refused = await inst.inTab(wsB, tabs.B1, guard);
    await inst.inTab(wsA, tabs.A1, inst.tabCli(['lease', 'release', `merge:${repo}`]));
    check(
      'bash-guard',
      'bash-guard allows a merge from the lease holder and refuses it from another tab',
      held.rc === 0 && allowed.rc === 0 && refused.rc === 2,
      `acquire ${held.rc}, guard in holder ${allowed.rc} (${allowed.err.trim().split('\n')[0] || 'no message'}), guard in other tab ${refused.rc}`,
      'acquire 0, guard in holder 0, guard in other tab 2',
    );
  }

  // ---- epic ownership (SC-2): refused while held, free once the holder tab closes
  const epic = `acc-${nonce}`;
  const own = await inst.inTab(wsA, tabs.A1, inst.tabCli(['lease', 'acquire', `epic:${epic}`, '--ttl', 'none']));
  const second = await inst.inTab(wsA, tabs.A2, inst.tabCli(['lease', 'acquire', `epic:${epic}`, '--ttl', 'none']));
  const closed = await inst.cli(['tab', 'close', '-w', wsA, tabs.A1]);
  let taken = { rc: -1, out: '', err: 'not tried' };
  const deadline = Date.now() + 60000;
  while (closed.rc === 0 && Date.now() < deadline) {
    taken = await inst.inTab(wsA, tabs.A2, inst.tabCli(['lease', 'acquire', `epic:${epic}`, '--ttl', 'none']));
    if (taken.rc === 0) break;
    await sleep(1000);
  }
  check(
    'epic-ownership',
    'an epic claim refuses a second tab and frees when its holder tab closes',
    own.rc === 0 && second.rc === 3 && closed.rc === 0 && taken.rc === 0,
    `acquire ${own.rc}, second ${second.rc}, close ${closed.rc}, second after close ${taken.rc}`,
    'acquire 0, second 3, close 0, second after close 0 within 60 s',
  );

  // ---- number claims survive the tab; release-epic releases them
  const num = `num:acc/repo-${nonce}:adr:0001`;
  const claim = await inst.inTab(wsA, tabs.A2, inst.tabCli(['lease', 'acquire', num, '--epic', epic]));
  const closedA2 = await inst.cli(['tab', 'close', '-w', wsA, tabs.A2]);
  await sleep(1000);
  const survived = await inst.cli(['lease', 'check', num]);
  const releaseEpic = await inst.cli(['lease', 'release-epic', epic]);
  const gone = await inst.cli(['lease', 'check', num]);
  check(
    'num-claim',
    'a number claim survives its tab closing and release-epic releases it',
    claim.rc === 0 && closedA2.rc === 0 && parseJson(survived.out)?.held === true && releaseEpic.rc === 0 && gone.rc === 7,
    `claim ${claim.rc}, close ${closedA2.rc}, held after close ${parseJson(survived.out)?.held}, release-epic ${releaseEpic.rc}, check after ${gone.rc}`,
    'claim 0, close 0, held after close true, release-epic 0, check after 7',
  );

  // ---- the CLI error contract (story 02)
  const gonePane = await inst.cli(['tab', 'send', '-w', wsA, tabs.A1, 'echo late']);
  check('exit-4-target-gone', 'tab send to a closed tab exits 4', gonePane.rc === 4, brief(gonePane), 'exit 4');
  const usage = await inst.cli(['definitely-not-a-command']);
  check('exit-2-usage', 'an unknown command exits 2', usage.rc === 2, brief(usage), 'exit 2');
  const nobody = await inst.cli(['lease', 'check', `merge:acc/nobody-${nonce}`]);
  check('exit-7-not-found', 'lease check of an unheld name exits 7 and prints held:false', nobody.rc === 7 && parseJson(nobody.out)?.held === false, brief(nobody), 'exit 7, {"held":false}');

  const fakeHome = path.join(inst.state.scratch, 'fake-home');
  fs.mkdirSync(path.join(fakeHome, '.purplemux'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.purplemux', 'cli-token'), 'x\n');
  const deadPort = await freePort();
  fs.writeFileSync(path.join(fakeHome, '.purplemux', 'port'), `${deadPort}\n`);
  const fakeEnv = { ...inst.env, HOME: fakeHome };
  const unreachable = await inst.cli(['lease', 'list'], { env: fakeEnv });
  check('exit-6-unreachable', 'a server that does not answer exits 6 server-unreachable', unreachable.rc === 6 && unreachable.err.includes('server-unreachable'), brief(unreachable), 'exit 6, server-unreachable');

  const oldServer = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<html>404</html>');
  });
  await new Promise((resolve) => oldServer.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(fakeHome, '.purplemux', 'port'), `${oldServer.address().port}\n`);
  const absent = await inst.cli(['lease', 'list'], { env: fakeEnv });
  await new Promise((resolve) => oldServer.close(resolve));
  check('exit-6-routes-absent', 'a server without the lease routes exits 6 routes-absent', absent.rc === 6 && absent.err.includes('routes-absent'), brief(absent), 'exit 6, routes-absent');

  await inst.cli(['tab', 'close', '-w', wsB, tabs.B1]);
  await story15(inst, { nonce, wsB, pass, fail, check });
  return results;
};

/** Poll `probe` every POLL_MS until it returns a truthy value or `ms` passes. */
const within = async (ms, probe) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value || Date.now() >= deadline) return value;
    await sleep(POLL_MS);
  }
};

/** Poll observed facts, returning the last observation rather than a stale pre-poll snapshot. */
const pollObservation = async (ms, probe) => {
  const deadline = Date.now() + ms;
  let last;
  do {
    last = await probe();
    if (last?.ok || Date.now() >= deadline) return last;
    await sleep(POLL_MS);
  } while (true);
};

/** Story 15 (ADR-0018): turn-end markers, WAITING, and the idle nudge of a stop with no end line (L49), in workspace B. */
const story15 = async (inst, { nonce, wsB, fail, check }) => {
  const orchTab = parseJson((await inst.cli(['tab', 'create', '-w', wsB, '-n', 'acc-orch', '-t', 'claude-code', '--no-launch'])).out);
  const orch = orchTab?.tabId;
  await inst.startFixtureAgent(wsB, orchTab, { composer: true });
  const on = orch ? await inst.designate(wsB, orch) : { rc: -1, out: '', err: 'no orchestrator tab' };
  const windowSet = await inst.cli(['config', 'set', 'watchdog.idle-nudge-minutes', IDLE_WINDOW_MIN]);
  if (!orch || on.rc !== 0 || windowSet.rc !== 0) {
    for (const id of ['turn-marker', 'turn-waiting', 'turn-ready']) fail(id, 'story 15 turn-end classification', `orchestration on: ${brief(on)}; idle window: ${brief(windowSet)}`, 'an orchestrator tab in workspace B and the idle window set');
    return;
  }
  const worker = async (name, transcript) => {
    const created = parseJson((await inst.cli(['tab', 'create', '-w', wsB, '-n', name, '-t', 'claude-code', '--no-launch'])).out);
    if (!created?.tabId) return null;
    await sleep(500);
    const started = await inst.startStandIn(created.sessionName, transcript);
    return started.rc === 0 ? created : null;
  };
  const stopTurn = async (w) => {
    await sleep(1000);
    await inst.hook('session-start', w.sessionName);
    await inst.hook('prompt-submit', w.sessionName);
    const busy = await within(10000, async () => (await inst.cliState(wsB, w.tabId)) === 'busy');
    w.stoppedAt = Date.now();
    const stopped = await inst.hook('stop', w.sessionName);
    return busy && stopped === 204;
  };

  const markerLine = `BLOCKED: acceptance marker ${nonce} — needs nothing`;
  const w1 = await worker('acc-marker', `Work done.\n\n${markerLine}`);
  const w1Stopped = w1 ? await stopTurn(w1) : false;
  const marker = w1Stopped ? await within(10000, async () => (await inst.nudgesFor(wsB, w1.tabId)).find((n) => n.kind === 'turn-marker')) : null;
  check(
    'turn-marker',
    'a stop whose last line is a marker sends a turn-marker nudge carrying that line',
    Boolean(marker && marker.message.includes(markerLine)),
    marker ? marker.message : `worker ${w1 ? 'created' : 'not created'}, stop ${w1Stopped ? 'posted' : 'not posted'}, no turn-marker nudge`,
    `a turn-marker nudge containing "${markerLine}"`,
  );

  // WAITING, proven by order and by timestamps rather than by a quiet interval (review round 1): a
  // later plain stop (w3) must have produced its nudge before w2 is read, and once w2's job ends,
  // w2's next stop must nudge READY with a timestamp after the job ended — a build that ignored the
  // job would have nudged at the first stop instead.
  const job = spawn('sleep', ['600'], { stdio: 'ignore', detached: true, env: { PATH: '/usr/bin:/bin', HOME: inst.state.home } });
  const stopJob = () => {
    try {
      process.kill(job.pid);
    } catch {
      // already gone
    }
  };
  process.on('exit', stopJob);
  const w2 = await worker('acc-waiting', 'Gate started; waiting on it.');
  const w3 = await worker('acc-plain', 'Finished the task.');
  const registered = w2 ? await inst.cli(['tab', 'bg', 'add', '-w', wsB, w2.tabId, '--pid', String(job.pid), '--label', 'acc-gate']) : { rc: -1, out: '', err: 'no worker' };
  const w2Stopped = w2 && registered.rc === 0 ? await stopTurn(w2) : false;
  const w3Stopped = w3 ? await stopTurn(w3) : false;
  const ready = w3Stopped ? await within(IDLE_WAIT_MS, async () => (await inst.nudgesFor(wsB, w3.tabId)).find((n) => n.kind === 'idle-no-end-line')) : null;
  const w3Nudges = w3 ? await inst.nudgesFor(wsB, w3.tabId) : [];
  check(
    'turn-ready',
    'a stop with no end line and no open work sends no immediate nudge, then ONE idle nudge after the window (L49)',
    Boolean(ready && ready.at - w3.stoppedAt >= IDLE_WINDOW_MS - 500 && w3Nudges.length === 1 && ready.message.includes('idle without an end line')),
    ready ? `${w3Nudges.map((n) => n.kind).join(',')}; idle nudge at +${ready.at - w3.stoppedAt} ms after the stop` : `stop ${w3Stopped ? 'posted' : 'not posted'}, no idle-no-end-line nudge`,
    `only an idle-no-end-line nudge, at least ${IDLE_WINDOW_MS - 500} ms after the stop`,
  );
  const w2State = w2 ? await inst.cliState(wsB, w2.tabId) : null;
  const w2Early = w2 ? await inst.nudgesFor(wsB, w2.tabId) : [];
  stopJob();
  // Gone, not a zombie: the server's liveness probe is kill(pid, 0), which a zombie still passes.
  const jobEnded = await within(5000, async () => !fs.existsSync(`/proc/${job.pid}`));
  const endedAt = Date.now();
  const w2Again = w2 && jobEnded ? await inst.hook('stop', w2.sessionName) : 0;
  // The job's own exit nudge (bg-*) goes out first; the stop after it has no end line and nothing
  // live, so its only nudge is the idle one after the window.
  const woke = w2Again === 204 ? await within(IDLE_WAIT_MS, async () => (await inst.nudgesFor(wsB, w2.tabId)).find((n) => n.kind === 'idle-no-end-line')) : null;
  check(
    'turn-waiting',
    'a stop with no marker and a live registered job is WAITING (busy, no nudge); once the job ends the next stop is READY (idle nudge after the window)',
    Boolean(w2Stopped && ready && w2State === 'busy' && w2Early.length === 0 && woke && woke.at >= endedAt),
    `bg add ${registered.rc}, stop posted ${w2Stopped}, after w3's nudge: cliState ${w2State}, nudges ${w2Early.map((n) => n.kind).join(',') || 'none'}; after the job ended: ${woke ? `idle nudge at +${woke.at - endedAt} ms` : 'no idle nudge'}`,
    'bg add 0, stop posted, cliState busy, no nudge; then an idle nudge stamped after the job ended',
  );
  // Wave 2 runs commands as the designated coordinator. Return this fixture from its foreground
  // composer to the shell while retaining the same tab/session identity and designation.
  await inst.keys(orchTab.sessionName, 'C-c');
  await sleep(500);
};

/** The wave-2 checks (story 22). Each pushes one result; a failed prerequisite fails what depends on it. */
const wave2 = async (inst) => {
  const results = [];
  const nonce = crypto.randomBytes(3).toString('hex');
  const { a: wsA, b: wsB } = inst.state.workspaces;
  const pass = (id, what) => results.push({ status: 'pass', id, what });
  const fail = (id, what, measured, expected) => results.push({ status: 'fail', id, what, measured, expected });
  const check = (id, what, ok, measured, expected) => (ok ? pass(id, what) : fail(id, what, measured, expected));
  const created = async (ws, name, type, extra = []) => parseJson((await inst.cli(['tab', 'create', '-w', ws, '-n', name, '-t', type, ...extra])).out);
  await fleetConfig(inst, { nonce, wsB, check });
  await tabCloseReap(inst, { wsA, check, created });
  await notes(inst, { nonce, wsA, wsB, check, created });
  await turnErrors(inst, { nonce, wsB, check, created });
  await compaction(inst, { wsB, check, created });
  await suggestions(inst, { nonce, wsA, check, created });
  return results;
};

/** Story 24 (ADR-0019): authority, and the `constructor` key that plain indexing read as Object. */
const fleetConfig = async (inst, { nonce, wsB, check }) => {
  // The orchestrator of workspace B (a claude-code tab with no agent launched, set by the story 15 checks) and a
  // plain worker tab. The orchestrator's command runs in its shell through tmux, not through `tab send`: a send into
  // an agent tab reports submitted only on a prompt-submit turn (vel-RETRO-R3), and a shell never posts one.
  const orchestrator = parseJson((await inst.cli(['orchestration', 'status', '-w', wsB])).out)?.orchestration?.orchestratorTabId ?? null;
  const orchestratorSession = orchestrator
    ? parseJson((await inst.cli(['tab', 'list', '-w', wsB])).out)?.tabs?.find((t) => t.tabId === orchestrator)?.sessionName ?? null
    : null;
  const worker = parseJson((await inst.cli(['tab', 'create', '-w', wsB, '-n', 'acc2-worker', '-t', 'terminal'])).out)?.tabId ?? null;
  await sleep(1000);
  const key = `acc.slots-${nonce}`;
  const bySelf = orchestrator && orchestratorSession
    ? await inst.inTab(wsB, orchestrator, inst.tabCli(['config', 'set', key, '4']), { session: orchestratorSession })
    : { rc: -1, out: '', err: orchestrator ? `no session for orchestrator ${orchestrator}` : 'no orchestrator' };
  const byWorker = worker ? await inst.inTab(wsB, worker, inst.tabCli(['config', 'set', key, '9'])) : { rc: -1, out: '', err: 'no worker tab' };
  const value = await inst.cli(['config', 'get', key]);
  check(
    'config-authority',
    'the orchestrator tab sets a fleet value; a worker tab of the same workspace is refused (exit 3); the value is the orchestrator\'s',
    bySelf.rc === 0 && byWorker.rc === 3 && value.out.trim() === '4',
    `orchestrator ${brief(bySelf)}; worker ${brief(byWorker)}; get "${value.out.trim()}"`,
    'orchestrator exit 0, worker exit 3, get "4"',
  );
  const unsetBefore = await inst.cli(['config', 'get', 'constructor']);
  const set = await inst.cli(['config', 'set', 'constructor', '5']);
  const got = await inst.cli(['config', 'get', 'constructor']);
  const listed = parseJson((await inst.cli(['config', 'list', '--json'])).out)?.values?.constructor ?? null;
  const unset = await inst.cli(['config', 'unset', 'constructor']);
  const after = await inst.cli(['config', 'get', 'constructor']);
  check(
    'config-constructor-key',
    'the key `constructor` is an ordinary key: unset exits 7, set/get round-trip with a whole-number version, unset, then exit 7 again',
    unsetBefore.rc === 7 && set.rc === 0 && got.rc === 0 && got.out.trim() === '5' && Number.isInteger(listed?.version) && unset.rc === 0 && after.rc === 7,
    `get ${unsetBefore.rc}, set ${brief(set)}, get ${got.rc} "${got.out.trim()}", version ${JSON.stringify(listed?.version)}, unset ${unset.rc}, get ${after.rc}`,
    'get 7, set 0, get 0 "5", an integer version, unset 0, get 7',
  );
  await inst.cli(['config', 'unset', key]);
  if (worker) await inst.cli(['tab', 'close', '-w', wsB, worker]);
};

const alive = (pid) => {
  try {
    const state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0];
    return state !== 'Z';
  } catch {
    return false;
  }
};

/** Story 16 (ADR-0016): a tab close reaps the tab's own setsid'd job and nothing of another tab's. */
const tabCloseReap = async (inst, { wsA, check, created }) => {
  const one = await created(wsA, 'acc2-reap-1', 'terminal');
  const two = await created(wsA, 'acc2-reap-2', 'terminal');
  await sleep(1000);
  const orphan = 'setsid nohup sleep 300 >/dev/null 2>&1 & echo $!';
  const mine = one ? await inst.inTab(wsA, one.tabId, orphan) : { rc: -1, out: '', err: 'no tab' };
  const theirs = two ? await inst.inTab(wsA, two.tabId, orphan) : { rc: -1, out: '', err: 'no tab' };
  const minePid = Number(mine.out.trim());
  const theirsPid = Number(theirs.out.trim());
  const started = minePid > 1 && theirsPid > 1 && alive(minePid) && alive(theirsPid);
  const closed = started ? await inst.cli(['tab', 'close', '-w', wsA, one.tabId]) : { rc: -1, out: '', err: 'jobs not started' };
  const lines = closed.out.trim().split('\n');
  const gone = started ? await within(5000, async () => !alive(minePid)) : false;
  const otherAlive = started && alive(theirsPid);
  check(
    'tab-close-reaps-own',
    'tab close reaps the closed tab\'s setsid job (listed as killed after "ok") and leaves another tab\'s job running',
    closed.rc === 0 && lines[0] === 'ok' && lines.some((l) => l.startsWith(`killed ${minePid} `)) && gone && otherAlive
      && !lines.some((l) => l.includes(` ${theirsPid} `)),
    `jobs ${minePid}/${theirsPid} started ${started}; close ${brief(closed)}, output ${JSON.stringify(lines.slice(0, 4))}; own gone ${gone}, other alive ${otherAlive}`,
    `exit 0, "ok" then "killed ${minePid} …"; ${minePid} gone; ${theirsPid} still running`,
  );
  // The second tab's close reaps its job too (and is the cleanup).
  if (two) await inst.cli(['tab', 'close', '-w', wsA, two.tabId]);
  // Only the job this check started: alive, still `sleep 300`, still carrying the second tab's marker.
  const ours = (pid) => {
    const environ = readIf(`/proc/${pid}/environ`) ?? '';
    const cmdline = readIf(`/proc/${pid}/cmdline`) ?? '';
    return two && environ.split('\0').includes(`PMUX_TAB_ID=${two.tabId}`) && cmdline === 'sleep\u0000300\u0000';
  };
  if (theirsPid > 1 && alive(theirsPid) && ours(theirsPid)) {
    try {
      process.kill(theirsPid, 'SIGKILL');
    } catch {
      // gone
    }
  }
};

/** Cross-workspace notes require real designated coordinators; local workers retain local authority. */
const notes = async (inst, { nonce, wsA, wsB, check, created }) => {
  const orch = await created(wsA, 'acc2-orch-a', 'claude-code', ['--no-launch']);
  const sender = await created(wsB, 'acc2-sender', 'claude-code', ['--no-launch']);
  const reader = await created(wsA, 'acc2-reader', 'claude-code', ['--no-launch']);
  const worker = await created(wsB, 'acc2-worker', 'claude-code', ['--no-launch']);
  const missing = { rc: -1, out: '', err: 'missing fixture prerequisite' };
  const epic = `acc-notes-${nonce}`;
  const bodyMarker = `ACC-NOTE-BODY-${nonce}`;
  const bodyFile = path.join(inst.state.scratch, 'io', `note-${nonce}.txt`);
  const inputFile = path.join(inst.state.scratch, 'io', `composer-input-${nonce}.txt`);
  fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
  fs.writeFileSync(bodyFile, `${bodyMarker}\nthe body is pulled, never typed\n`);
  fs.writeFileSync(inputFile, '');
  const inShell = (ws, tab, command) => inst.inTab(ws, tab.tabId, command, { session: tab.sessionName });
  const send = (target) => inst.tabCli(['note', 'send', ...target, '--subject', `acc note ${nonce}`, '-f', bodyFile]);
  const allNotes = async () => parseJson((await inst.cli(['note', 'list'])).out)?.notes ?? [];
  const waitDelivery = async (note) => note ? within(180000, async () => (await allNotes()).find((n) => n.id === note.id && typeof n.deliveredAt === 'number')) : null;
  try {
    await sleep(1000);
    const standIn = orch ? await inst.startFixtureAgent(wsA, orch, { composer: true, inputFile }) : missing;
    for (const [ws, tab] of [[wsB, sender], [wsA, reader], [wsB, worker]]) await inst.startFixtureAgent(ws, tab, { background: true });
    const onA = orch ? await inst.designate(wsA, orch.tabId) : missing;
    const onB = sender ? await inst.designate(wsB, sender.tabId) : missing;
    const before = (await allNotes()).length;
    const byWorker = worker ? await inShell(wsB, worker, send(['--to-workspace', wsA])) : missing;
    const changedB = worker ? await inst.designate(wsB, worker.tabId) : missing;
    const byStaleSender = sender && changedB.rc === 0 ? await inShell(wsB, sender, send(['--to-workspace', wsA])) : missing;
    const restoredB = sender ? await inst.designate(wsB, sender.tabId) : missing;
    check('note-source-authority', 'foreign workers and replaced source coordinators cannot create notes',
      onB.rc === 0 && byWorker.rc === 3 && byStaleSender.rc === 3 && restoredB.rc === 0 && (await allNotes()).length === before,
      `worker ${brief(byWorker)}; stale coordinator ${brief(byStaleSender)}; restore ${brief(restoredB)}`, 'both denied with exit 3 and no new note');

    await sleep(1500);
    if (orch) await inst.hook('session-start', orch.sessionName);
    const ready = orch ? await within(10000, async () => (await inst.cliState(wsA, orch.tabId)) === 'idle') : false;
    const directMarker = `ACC-FOREIGN-DIRECT-${nonce}`;
    const direct = [];
    for (const action of ['send', 'steer']) direct.push(sender && orch ? await inShell(wsB, sender,
      inst.tabCli(['tab', action, '-w', wsA, orch.tabId, directMarker])) : missing);
    check('note-no-direct-drive', 'a foreign coordinator cannot send or steer even the designated target coordinator',
      direct.every((r) => r.rc === 3) && !(readIf(inputFile) ?? '').includes(directMarker),
      direct.map(brief).join('; '), 'both denied with exit 3 and no direct input');

    const sent = sender && ready && standIn.rc === 0 && restoredB.rc === 0
      ? await inShell(wsB, sender, send(['--to-workspace', wsA])) : missing;
    const note = parseJson(sent.out)?.note ?? null;
    const delivered = await waitDelivery(note);
    const judged = judgeNoteDelivery(delivered ?? note, readIf(inputFile) ?? '', bodyMarker);
    check('note-delivered', 'a designated coordinator sends a fixed notice to the foreign coordinator; the body is never typed',
      sent.rc === 0 && judged.ok && delivered?.deliveredTo?.tabId === orch?.tabId,
      `send ${brief(sent)}; ${judged.measured}`, 'send exit 0, coordinator delivery stamped, notice received without body');

    // An epic held by a worker still routes foreign notes to that workspace's coordinator.
    const held = reader ? await inShell(wsA, reader, inst.tabCli(['lease', 'acquire', `epic:${epic}`, '--ttl', '5m'])) : missing;
    const epicSent = sender && held.rc === 0 ? await inShell(wsB, sender, send(['--to-epic', epic])) : missing;
    const epicNote = parseJson(epicSent.out)?.note ?? null;
    const epicDelivered = await waitDelivery(epicNote);
    check('note-epic-coordinator', 'a foreign note addressed to a worker-held epic is delivered to its current coordinator',
      epicSent.rc === 0 && epicDelivered?.deliveredTo?.tabId === orch?.tabId && judgeNoteDelivery(epicDelivered, readIf(inputFile) ?? '', bodyMarker).ok,
      `epic lease ${brief(held)}; send ${brief(epicSent)}; recipient ${epicDelivered?.deliveredTo?.tabId}`, 'epic holder is the worker; delivered recipient is the coordinator');

    const shown = note && sender ? await inShell(wsB, sender, inst.tabCli(['note', 'show', note.id])) : missing;
    const bySender = note && sender ? await inShell(wsB, sender, inst.tabCli(['note', 'ack', note.id])) : missing;
    const byReader = note && reader ? await inShell(wsA, reader, inst.tabCli(['note', 'ack', note.id])) : missing;
    // End only the scratch stand-in; the shell still carries the same launch-bound coordinator token.
    const stopped = orch ? await inst.keys(orch.sessionName, 'C-c') : missing;
    const byRecipient = note && orch && stopped.rc === 0 ? await inst.inTab(wsA, orch.tabId,
      inst.tabCli(['note', 'ack', note.id, '--comment', 'seen']), { session: orch.sessionName }) : missing;
    check('note-ack', 'the source coordinator and recipient worker cannot ACK; the current recipient coordinator can',
      shown.rc === 0 && (parseJson(shown.out)?.body ?? '').includes(bodyMarker) && bySender.rc === 3 && byReader.rc === 3
        && byRecipient.rc === 0 && parseJson(byRecipient.out)?.note?.state === 'acked',
      `show ${brief(shown)}; sender ${brief(bySender)}; worker ${brief(byReader)}; coordinator ${brief(byRecipient)}`, 'show 0, sender/worker ACK 3, current coordinator ACK 0');

    if (reader) await inst.startFixtureAgent(wsA, reader, { composer: true });
    const replaced = reader ? await inst.designate(wsA, reader.tabId) : missing;
    const staleAck = epicNote && orch && replaced.rc === 0 ? await inst.inTab(wsA, orch.tabId,
      inst.tabCli(['note', 'ack', epicNote.id]), { session: orch.sessionName }) : missing;
    const rerouted = epicNote && reader ? await within(30000, async () => (await allNotes())
      .find((n) => n.id === epicNote.id && n.deliveredTo?.tabId === reader.tabId)) : null;
    if (reader) await inst.keys(reader.sessionName, 'C-c');
    const currentAck = rerouted && reader ? await inShell(wsA, reader, inst.tabCli(['note', 'ack', epicNote.id])) : missing;
    check('note-stale-recipient', 'a replaced recipient cannot ACK; the newly designated coordinator can',
      staleAck.rc === 3 && currentAck.rc === 0 && parseJson(currentAck.out)?.note?.state === 'acked',
      `stale ${brief(staleAck)}; current ${brief(currentAck)}`, 'stale ACK 3; current coordinator ACK 0');
  } finally {
    const released = reader ? await inShell(wsA, reader, inst.tabCli(['lease', 'release', `epic:${epic}`])) : missing;
    const retainA = await retainDesignatedFixture(inst, wsA, [orch, reader], {
      restore: (tab) => inst.restoreLiveFixtureAgent(wsA, tab),
    });
    const retainB = await retainDesignatedFixture(inst, wsB, [sender, worker], {
      restore: (tab) => inst.restoreLiveFixtureAgent(wsB, tab),
    });
    check(
      'note-designated-housekeeping',
      'note cleanup releases its fixture lease, retains each actual designated coordinator live with unchanged mapping, and closes only the other temporary tabs',
      released.rc === 0 && retainA.ok && retainB.ok,
      `lease ${brief(released)}; A ${retainA.measured}; B ${retainB.measured}`,
      'lease release exit 0; actual designated tabs retained live; every other close exits 0 with ok; mappings unchanged',
    );
  }
};

// Story 26 transcripts: the real Claude 2.1.283 server-error entry, and the usage WARNING (a normal
// turn that only mentions the pane footer — never an error, never a resume).
const API_ERROR_TRANSCRIPT = () => [
  { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'go' } },
  { type: 'assistant', timestamp: new Date().toISOString(), error: 'server_error', isApiErrorMessage: true, uuid: crypto.randomUUID(), message: { model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', stop_sequence: '', type: 'message', content: [{ type: 'text', text: 'API Error: Server error mid-response. The response above may be incomplete.' }] } },
];
// It ends on a marker line, so the turn-marker nudge proves the stop READ this transcript (a stop
// that found no transcript falls back to READY, which would pass a READY-based check vacuously).
const USAGE_WARNING_TRANSCRIPT = (marker) => [
  { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'go' } },
  { type: 'assistant', timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `P1's pane shows "You've used 92% of your session limit · resets 9:20am (UTC) · /upgrade to k…". Nothing to do until the reset.\n\n${marker}` }] } },
];

/** Start a stand-in worker in workspace B and drive one turn to its stop. */
const turnOf = async (inst, wsB, created, name, transcript) => {
  const w = await created(wsB, name, 'claude-code', ['--no-launch']);
  if (!w) return null;
  await sleep(500);
  if ((await inst.startStandIn(w.sessionName, transcript)).rc !== 0) return null;
  await sleep(1000);
  await inst.hook('session-start', w.sessionName);
  await inst.hook('prompt-submit', w.sessionName);
  const busy = await within(10000, async () => (await inst.cliState(wsB, w.tabId)) === 'busy');
  return busy ? w : null;
};

/** Story 26: an API-error stop queues ONE resume and sends no READY; the usage WARNING is a plain turn. */
const turnErrors = async (inst, { nonce, wsB, check, created }) => {
  const err = await turnOf(inst, wsB, created, 'acc2-api-error', API_ERROR_TRANSCRIPT());
  const errStopped = err ? await inst.hook('stop', err.sessionName) : 0;
  const resume = errStopped === 204 ? await within(10000, async () => (await inst.inbox(wsB)).find((i) => i.kind === 'resume' && i.targetTabId === err.tabId)) : null;
  const errNudges = err ? await inst.nudgesFor(wsB, err.tabId) : [];
  const resumes = err ? (await inst.inbox(wsB)).filter((i) => i.kind === 'resume' && i.targetTabId === err.tabId).length : 0;
  check(
    'api-error-resume',
    'a stop on a Claude API error queues one resume notice for the tab and sends no READY FOR REVIEW nudge',
    Boolean(resume) && resumes === 1 && !errNudges.some((n) => n.kind === 'ready-for-review'),
    `stop ${errStopped}, resume items ${resumes}, nudges ${errNudges.map((n) => n.kind).join(',') || 'none'}`,
    'one resume inbox item, no ready-for-review nudge',
  );
  const marker = `DONE: acceptance usage warning ${nonce}`;
  const warn = await turnOf(inst, wsB, created, 'acc2-usage-warning', USAGE_WARNING_TRANSCRIPT(marker));
  const warnStopped = warn ? await inst.hook('stop', warn.sessionName) : 0;
  const ended = warnStopped === 204 ? await within(10000, async () => (await inst.nudgesFor(wsB, warn.tabId)).find((n) => n.kind === 'turn-marker')) : null;
  const warnResumes = warn ? (await inst.inbox(wsB)).filter((i) => i.targetTabId === warn.tabId).length : -1;
  check(
    'usage-warning-negative',
    'a turn that quotes the usage WARNING footer is an ordinary turn: its marker nudge (the transcript was read), no resume, no halt',
    Boolean(ended && ended.message.includes(marker)) && warnResumes === 0,
    `stop ${warnStopped}, turn-marker nudge ${ended ? JSON.stringify(ended.message.slice(0, 120)) : 'none'}, inbox items for the tab ${warnResumes}`,
    `a turn-marker nudge carrying "${marker}" and no inbox item`,
  );
  for (const t of [err, warn]) if (t) await inst.cli(['tab', 'close', '-w', wsB, t.tabId]);
};

/** Story 32 (L30): an auto-compaction's SessionStart (source=compact) keeps the turn busy with no nudge. */
const compaction = async (inst, { wsB, check, created }) => {
  const w = await turnOf(inst, wsB, created, 'acc2-compact', 'Still working.');
  const before = w ? (await inst.nudgesFor(wsB, w.tabId)).length : -1;
  if (w) {
    await inst.hook('pre-compact', w.sessionName);
    await inst.hook('session-start', w.sessionName, { source: 'compact' });
  }
  await sleep(3000);
  const state = w ? await inst.cliState(wsB, w.tabId) : null;
  const after = w ? await inst.nudgesFor(wsB, w.tabId) : [];
  // The same tab still ends its turn normally afterwards: the check is not passing on a dead tab.
  const stopped = w ? await inst.hook('stop', w.sessionName) : 0;
  const ready = stopped === 204 ? await within(IDLE_WAIT_MS, async () => (await inst.nudgesFor(wsB, w.tabId)).find((n) => n.kind === 'idle-no-end-line')) : null;
  check(
    'compaction-no-turn-end',
    'a SessionStart with source=compact mid-turn leaves the tab busy and sends no nudge; its later stop is READY (idle nudge after the window)',
    state === 'busy' && after.length === before && Boolean(ready),
    `cliState ${state}, nudges ${before} → ${after.length} (${after.map((n) => n.kind).join(',') || 'none'}), later idle nudge ${Boolean(ready)}`,
    'busy, no new nudge, then an idle-no-end-line nudge after the stop',
  );
  if (w) await inst.cli(['tab', 'close', '-w', wsB, w.tabId]);
};

/** Story 17 (L7): `tab result` marks dim composer text as a suggestion; --no-suggestions and --raw. */
const suggestions = async (inst, { nonce, wsA, check, created }) => {
  const t = await created(wsA, 'acc2-ghost', 'claude-code', ['--no-launch']);
  await sleep(1000);
  const ghost = `ghost ${nonce}`;
  // Drawn by printf in the pane's shell: a composer line whose text is dim (SGR 2), as Claude draws one.
  const drawn = t ? await inst.keys(t.sessionName, `clear; printf '────\\n\\342\\235\\257 \\033[2m%s\\033[0m\\n────\\n' '${ghost}'`) : { rc: -1 };
  const plain = t && drawn.rc === 0
    ? await within(10000, async () => {
      const r = parseJson((await inst.cli(['tab', 'result', '-w', wsA, t.tabId])).out);
      return r?.suggestion ? r : null;
    })
    : null;
  const none = t ? parseJson((await inst.cli(['tab', 'result', '-w', wsA, t.tabId, '--no-suggestions'])).out) : null;
  const raw = t ? parseJson((await inst.cli(['tab', 'result', '-w', wsA, t.tabId, '--raw'])).out) : null;
  const marked = (plain?.content ?? '').split('\n').some((l) => l.startsWith('❯') && l.includes(`[suggestion] ${ghost}`));
  check(
    'result-suggestion',
    '`tab result` prints dim composer text as "[suggestion] <text>" and returns it; --no-suggestions drops it; --raw keeps the escapes',
    drawn.rc === 0 && marked && plain?.suggestion === ghost && none?.suggestion === null && !(none?.content ?? '').includes(ghost)
      && (raw?.content ?? '').includes('\u001b[2m'),
    `drawn ${drawn.rc}; marked ${marked}, suggestion ${JSON.stringify(plain?.suggestion)}; --no-suggestions ${JSON.stringify(none?.suggestion)} text present ${(none?.content ?? '').includes(ghost)}; --raw has SGR 2 ${(raw?.content ?? '').includes('\u001b[2m')}`,
    `a "❯ [suggestion] ${ghost}" line and suggestion "${ghost}"; null and absent; SGR 2 present`,
  );
  if (t) await inst.cli(['tab', 'close', '-w', wsA, t.tabId]);
};

const TARGETED_FIXTURE_IDS = [
  'target-fresh-bind',
  'target-watchdog-note-once',
  'target-live-retain',
  'target-shell-control-rejected',
  'target-stopped-revive',
  'target-stale-identity-rejected',
  'target-background-rejected',
  'target-subsequent-create',
];

const appendTargetedPrerequisiteFailures = (results, ids, reason) => {
  for (const id of ids) results.push({
    status: 'fail',
    id,
    what: 'targeted fixture prerequisite is complete before dependent operations run',
    measured: reason,
    expected: 'all prior targeted fixture prerequisites pass',
  });
  return results;
};

/** Architect-bounded real-fixture proof for retained coordinator identity and safe shell submission. */
const targetedFixtureProof = async (inst) => {
  const results = [];
  const nonce = crypto.randomBytes(4).toString('hex');
  const { a: wsA, b: wsB } = inst.state.workspaces;
  const pass = (id, what) => results.push({ status: 'pass', id, what });
  const fail = (id, what, measured, expected) => results.push({ status: 'fail', id, what, measured, expected });
  const check = (id, what, ok, measured, expected) => (ok ? pass(id, what) : fail(id, what, measured, expected));
  const create = async (ws, name, type = 'claude-code') => {
    const args = ['tab', 'create', '-w', ws, '-n', name, '-t', type];
    if (type !== 'terminal') args.push('--no-launch');
    const result = await inst.cli(args);
    return result.rc === 0 ? parseJson(result.out) : null;
  };
  const mapping = async (ws) => parseJson((await inst.cli(['orchestration', 'status', '-w', ws])).out)?.orchestration ?? null;
  const allNotes = async () => parseJson((await inst.cli(['note', 'list'])).out)?.notes ?? [];

  const recipient = await create(wsA, `target-recipient-${nonce}`);
  const sender = await create(wsB, `target-sender-${nonce}`);
  const worker = await create(wsB, `target-worker-${nonce}`);
  const inputFile = path.join(inst.state.scratch, 'io', `target-note-${nonce}.txt`);
  const bodyFile = path.join(inst.state.scratch, 'io', `target-body-${nonce}.txt`);
  fs.mkdirSync(path.dirname(inputFile), { recursive: true });
  fs.writeFileSync(inputFile, '');
  fs.writeFileSync(bodyFile, `TARGET-BODY-${nonce}\n`);

  const fresh = recipient
    ? await inst.startLiveFixtureAgent(wsA, recipient, { inputFile, phase: 'target-fresh' })
    : completeResult(null, 'recipient not created');
  const senderStarted = sender
    ? await inst.startFixtureAgent(wsB, sender, { background: true })
    : completeResult(null, 'sender not created');
  const workerStarted = worker
    ? await inst.startFixtureAgent(wsB, worker, { background: true })
    : completeResult(null, 'worker not created');
  const startsReady = fresh.rc === 0 && senderStarted.rc === 0 && workerStarted.rc === 0;
  const designatedA = recipient && startsReady
    ? await inst.designate(wsA, recipient.tabId)
    : completeResult(null, 'fixture starts did not all pass');
  const designatedB = sender && startsReady
    ? await inst.designate(wsB, sender.tabId)
    : completeResult(null, 'fixture starts did not all pass');
  const initialIdentity = recipient ? inst.fixtureAgents.get(recipient.tabId) : null;
  check(
    'target-fresh-bind',
    'a fresh live stand-in binds only after its physical UUID/PID/start identity is pinned',
    fresh.rc === 0 && Boolean(initialIdentity) && fresh.observation?.facts?.failedPredicates?.length === 0,
    `fresh ${brief(fresh)} identity ${JSON.stringify(initialIdentity ?? null)} evidence ${JSON.stringify(fresh.evidence ?? [])}`,
    'launch exit 0, a pinned identity, and no failed binding predicate',
  );
  const prerequisitesReady = startsReady && designatedA.rc === 0 && designatedB.rc === 0 && Boolean(initialIdentity);
  if (!prerequisitesReady) {
    const reason = `fresh ${brief(fresh)}; sender ${brief(senderStarted)}; worker ${brief(workerStarted)}; designate A ${brief(designatedA)}; designate B ${brief(designatedB)}; identity ${JSON.stringify(initialIdentity ?? null)}`;
    appendTargetedPrerequisiteFailures(results, TARGETED_FIXTURE_IDS.slice(1), reason);
    inst.persistFixtureObservation('targeted-summary', { results, fixtureAgents: Object.fromEntries(inst.fixtureAgents), prerequisiteFailure: reason });
    return results;
  }

  const noteBefore = (await allNotes()).length;
  const noteCommand = inst.tabCli(['note', 'send', '--to-workspace', wsA, '--subject', `target ${nonce}`, '-f', bodyFile]);
  const workerDenied = worker
    ? await inst.inTab(wsB, worker.tabId, noteCommand, { session: worker.sessionName })
    : completeResult(null, 'worker fixture missing');
  const preloaded = sender
    ? await inst.preloadPendingInput(sender.sessionName, '[orchestrator-watchdog] sender is INACTIVE ')
    : completeResult(null, 'sender fixture missing');
  const sent = sender
    ? await inst.inTab(wsB, sender.tabId, noteCommand, { session: sender.sessionName, timeoutMs: 30000 })
    : completeResult(null, 'sender fixture missing');
  const note = parseJson(sent.out)?.note ?? null;
  const delivered = note ? await within(180000, async () => (await allNotes()).find((entry) => entry.id === note.id && typeof entry.deliveredAt === 'number')) : null;
  const sourceAck = note && sender
    ? await inst.inTab(wsB, sender.tabId, inst.tabCli(['note', 'ack', note.id]), { session: sender.sessionName })
    : completeResult(null, 'note send did not return a note');
  const noteAfter = await allNotes();
  const input = readIf(inputFile) ?? '';
  const noticeCount = note?.id ? input.split(`[purplemux note ${note.id}]`).length - 1 : 0;
  const receipt = sent.operation ? inst.shellReceipt(sent.operation) : null;
  check(
    'target-watchdog-note-once',
    'pending watchdog text is cleared before one note command whose receipt proves routing and denials',
    workerDenied.rc === 3 && preloaded.rc === 0 && sent.rc === 0 && receipt === 0 && noteAfter.length === noteBefore + 1
      && delivered?.deliveredTo?.tabId === recipient?.tabId && noticeCount === 1 && sourceAck.rc === 3,
    `worker ${brief(workerDenied)} preload ${brief(preloaded)} send ${brief(sent)} receipt ${receipt} notes ${noteBefore}->${noteAfter.length} recipient ${delivered?.deliveredTo?.tabId ?? 'none'} notices ${noticeCount} source ACK ${brief(sourceAck)}`,
    'worker send denied; one received CLI command with receipt 0; one note routed once to the coordinator; source ACK denied',
  );

  const beforeLiveIdentity = recipient ? inst.fixtureAgents.get(recipient.tabId) : null;
  const beforeLiveMapping = await mapping(wsA);
  const liveOther = await create(wsA, `target-live-other-${nonce}`, 'terminal');
  const retainedLive = await retainDesignatedFixture(inst, wsA, [recipient, liveOther]);
  const afterLiveIdentity = recipient ? inst.fixtureAgents.get(recipient.tabId) : null;
  check(
    'target-live-retain',
    'an already-live designated fixture is retained without restart while only the other tab closes',
    retainedLive.ok && JSON.stringify(beforeLiveIdentity) === JSON.stringify(afterLiveIdentity),
    `${retainedLive.measured}; identity ${JSON.stringify(beforeLiveIdentity)} -> ${JSON.stringify(afterLiveIdentity)}`,
    'retention passes and the pinned identity is byte-identical',
  );

  const stopped = recipient ? await inst.keys(recipient.sessionName, 'C-c') : { rc: -1 };
  const launchReceipt = recipient && inst.shellOperations.get(recipient.sessionName)
    ? await within(5000, async () => inst.shellReceipt(inst.shellOperations.get(recipient.sessionName)) !== null)
    : false;
  const shellControl = recipient ? await inst.isolatedShellState(recipient.sessionName) : { ok: false };
  const shellNegative = recipient && beforeLiveIdentity ? await inst.observeFixtureAgent(wsA, recipient, beforeLiveIdentity) : { ok: true, facts: {} };
  check(
    'target-shell-control-rejected',
    'a foreground shell after the stand-in stops is never accepted as the pinned coordinator process',
    stopped.rc === 0 && launchReceipt && shellControl.ok && !shellNegative.ok
      && shellNegative.facts.failedPredicates.includes('command'),
    `stop ${brief(stopped)} receipt ${launchReceipt} shell ${JSON.stringify(shellControl)} observation ${JSON.stringify(shellNegative)}`,
    'the launch receipt is terminal, foreground shell is proven, and the agent observation rejects command',
  );

  const reviveOther = await create(wsA, `target-revive-other-${nonce}`, 'terminal');
  const revived = await retainDesignatedFixture(inst, wsA, [recipient, reviveOther], {
    restore: (tab) => inst.restoreLiveFixtureAgent(wsA, tab),
  });
  const revivedIdentity = recipient ? inst.fixtureAgents.get(recipient.tabId) : null;
  const afterReviveMapping = await mapping(wsA);
  check(
    'target-stopped-revive',
    'a stopped coordinator revives in the same tab and tmux session with unchanged designation and revision',
    revived.ok && Boolean(revivedIdentity) && revivedIdentity.sessionId !== beforeLiveIdentity?.sessionId
      && revivedIdentity.pid !== beforeLiveIdentity?.pid && recipient?.sessionName
      && beforeLiveMapping?.orchestratorTabId === recipient?.tabId
      && JSON.stringify(beforeLiveMapping) === JSON.stringify(afterReviveMapping),
    `${revived.measured}; session ${recipient?.sessionName ?? 'none'}; identity ${JSON.stringify(beforeLiveIdentity)} -> ${JSON.stringify(revivedIdentity)}; mapping ${JSON.stringify(beforeLiveMapping)} -> ${JSON.stringify(afterReviveMapping)}`,
    'new UUID/PID in the same tab/session and byte-identical orchestration mapping',
  );

  const stale = recipient && revivedIdentity
    ? await inst.observeFixtureAgent(wsA, recipient, { ...revivedIdentity, startTicks: revivedIdentity.startTicks + 1 })
    : { ok: true, facts: {} };
  check(
    'target-stale-identity-rejected',
    'a stale process-start identity is rejected even when the tab is otherwise live and bound',
    !stale.ok && stale.facts.failedPredicates.includes('sameIdentity'),
    JSON.stringify(stale),
    'sameIdentity is the failed predicate',
  );

  const backgroundTab = await create(wsA, `target-background-${nonce}`);
  let background = { rc: -1, observation: null };
  if (backgroundTab) {
    const backgroundId = crypto.randomUUID();
    const script = path.join(inst.state.scratch, 'bin', `background-claude-${nonce}`);
    fs.writeFileSync(script, [
      '#!/bin/bash',
      'd="$HOME/.claude/sessions"; mkdir -p "$d"',
      'printf \'{"pid":%d,"sessionId":"%s","cwd":"%s","startedAt":%s}\\n\' "$$" "$1" "$PWD" "$(( $(date +%s%N) / 1000000 ))" > "$d/$$.json"',
      'exec -a claude sleep 300',
      '',
    ].join('\n'));
    fs.chmodSync(script, 0o755);
    const launchedAfter = Date.now();
    const command = `${shellQuote(script)} ${shellQuote(backgroundId)} </dev/null >/dev/null 2>&1 &`;
    const launched = await inst.isolatedShellCommand(backgroundTab.sessionName, command);
    const observation = launched.rc === 0
      ? await pollObservation(FIXTURE_PROCESS_WAIT_MS, async () => {
        const observed = await inst.observeFixtureAgent(wsA, backgroundTab, { sessionId: backgroundId, launchedAfter });
        return { ...observed, ok: Boolean(observed.facts.record && observed.facts.process) };
      })
      : null;
    background = { ...launched, observation };
  }
  check(
    'target-background-rejected',
    'a real background Claude-shaped process with a fresh session record is not accepted as foreground coordinator work',
    background.rc === 0 && background.observation?.facts?.record && background.observation?.facts?.process
      && background.observation.facts.foreground === false && background.observation.facts.failedPredicates.includes('foreground'),
    JSON.stringify(background),
    'the process and record exist, but foreground is false and rejected',
  );
  if (backgroundTab) await inst.cli(['tab', 'close', '-w', wsA, backgroundTab.tabId]);

  const subsequent = await create(wsA, `target-subsequent-${nonce}`);
  check(
    'target-subsequent-create',
    'after other fixture tabs are cleaned up, a legitimate agent tab can still be created',
    Boolean(subsequent?.tabId),
    JSON.stringify(subsequent ?? null),
    'a new agent tab id',
  );
  if (subsequent) await inst.cli(['tab', 'close', '-w', wsA, subsequent.tabId]);

  inst.persistFixtureObservation('targeted-summary', { results, fixtureAgents: Object.fromEntries(inst.fixtureAgents) });
  return results;
};

const notesOnly = async (inst) => {
  const results = [];
  const nonce = crypto.randomBytes(3).toString('hex');
  const { a: wsA, b: wsB } = inst.state.workspaces;
  const check = (id, what, ok, measured, expected) => results.push(ok
    ? { status: 'pass', id, what }
    : { status: 'fail', id, what, measured, expected });
  const created = async (ws, name, type, extra = []) => parseJson((await inst.cli([
    'tab', 'create', '-w', ws, '-n', name, '-t', type, ...extra,
  ])).out);
  await notes(inst, { nonce, wsA, wsB, check, created });
  return results;
};

const targetedFixtureWithNotes = async (inst) => {
  const targeted = await targetedFixtureProof(inst);
  if (targeted.some((result) => result.status === 'fail')) {
    return [
      ...targeted,
      {
        status: 'fail',
        id: 'notes-only-prerequisite',
        what: 'notes-only proof starts only after all targeted fixture checks pass',
        measured: 'one or more targeted fixture checks failed',
        expected: 'all eight targeted fixture checks pass',
      },
    ];
  }
  return [...targeted, ...(await notesOnly(inst))];
};

const freePort = () =>
  new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** The waves in run order; `--only-wave N` selects the Nth. Building the list calls no wave. */
const wavesFor = (inst, opts, helpers) => [() => wave1(inst, opts), () => wave2(inst), () => wave3(inst, helpers), () => wave4(inst, helpers),
  () => wave5(inst, helpers), () => wave6(inst, helpers), () => wave7(inst), () => wave8(inst),
  () => wave9(inst, helpers), () => wave10(inst, helpers), () => wave11(inst, helpers), () => waveAttentionAlert(inst, helpers),
  () => wave13(inst, helpers), () => wave14(inst, helpers),
  () => wave15(inst, helpers)];
const WAVE_COUNT = wavesFor(null, {}, {}).length;

const parseArgs = (argv) => {
  const opts = { state: null, bashGuard: null, requireBashGuard: false, onlyWave: null, targetedFixture: false, evidenceDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state') opts.state = argv[++i];
    // Debugging one wave against a kept instance; run.sh and the deploy gate never pass it.
    else if (argv[i] === '--only-wave') {
      const raw = argv[++i];
      opts.onlyWave = /^\d+$/.test(raw ?? '') ? Number(raw) : NaN;
      if (!(opts.onlyWave >= 1 && opts.onlyWave <= WAVE_COUNT)) throw new Error(`--only-wave takes an integer 1..${WAVE_COUNT}, not ${JSON.stringify(raw ?? null)}`);
    }
    else if (argv[i] === '--targeted-fixture') opts.targetedFixture = true;
    else if (argv[i] === '--evidence-dir') opts.evidenceDir = argv[++i];
    else if (argv[i] === '--bash-guard') opts.bashGuard = argv[++i];
    else if (argv[i] === '--require-bash-guard') opts.requireBashGuard = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!opts.state) throw new Error('usage: checks.cjs --state <state.json> [--targeted-fixture] [--evidence-dir <path>] [--bash-guard <path>] [--require-bash-guard]');
  if (opts.onlyWave !== null && opts.targetedFixture) throw new Error('--only-wave and --targeted-fixture are mutually exclusive');
  return opts;
};

const main = async (argv) => {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  const state = parseJson(readIf(opts.state) || '');
  if (!state || !state.candidate || !state.home || !state.workspaces) {
    process.stderr.write(`REFUSED STATE — ${opts.state} is not an isolated-instance state file\n`);
    return 2;
  }
  if (opts.bashGuard && !fs.existsSync(opts.bashGuard)) {
    process.stderr.write(`REFUSED BASH-GUARD — ${opts.bashGuard} does not exist\n`);
    return 2;
  }
  if (opts.evidenceDir) state.evidenceDir = path.resolve(opts.evidenceDir);
  const inst = new Instance(state);
  const helpers = { parseJson, within, sleep, brief, shellQuote, readIf, retainDesignatedFixture };
  const waves = opts.targetedFixture ? [() => targetedFixtureWithNotes(inst)] : wavesFor(inst, opts, helpers);
  // The WIP cap gate runs first: a run whose scratch cap is not set (or not restored) runs no check.
  const fullRun = !opts.targetedFixture && opts.onlyWave === null;
  const gate = await fixtureCapGate(inst, { ...helpers, nonce: crypto.randomBytes(3).toString('hex') }, { refusalCheck: fullRun });
  const results = [...gate.results];
  for (const [i, wave] of (gate.proceed ? waves : []).entries()) {
    if (opts.targetedFixture || opts.onlyWave === null || opts.onlyWave === i + 1) results.push(...(await wave()));
  }
  const { lines, pass } = summarize(results, opts);
  process.stdout.write(`${lines.join('\n')}\n`);
  return pass ? 0 : 1;
};

module.exports = {
  Instance, notes, judgeRace, judgeNoteDelivery, summarize, shellQuote, parseArgs,
  retainDesignatedFixture, assessFixtureAgent, assessShellControl, fixturePhysicalObservation,
  pollObservation, processIdentity, processDescendsFrom, completeResult, brief, parseJson,
  appendTargetedPrerequisiteFailures, targetedFixtureProof, notesOnly, targetedFixtureWithNotes, WAVE_COUNT,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
