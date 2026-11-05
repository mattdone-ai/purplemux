'use strict';
// Wave-11 acceptance checks: the context lifecycle (ADR-0036, story 10 AC 7) through the candidate's production
// build. A scratch seat (a claude-code tab created with --handoff and --rotate-at 50000, run by the live stand-in)
// gets a statusline reading over its threshold at its prompt and is sent ROTATE; it writes a real handoff file and
// ends its turn with HANDOFF-READY; the server checks the file, restarts the tab --clear under the same id, and
// types "Read <path>, then continue: <resume command>" into the fresh session. Never a live seat: the instance has
// its own port, HOME and tmux socket.
//
// `wave11(inst, helpers)` returns results in checks.cjs's shape: { status, id, what, measured?, expected? }.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { request } = require('./checks-wave4.cjs');

/**
 * A hook as status-hook.sh posts it, with its occurrence time: only such a hook acknowledges the turn a paste
 * recorded (orchestration-activity.ts), and `tab restart` refuses a tab whose turn is still pending.
 */
const hookAt = (inst, token, event, session) => request(inst.state.port, 'POST', `/api/status/hook?occurredAt=${Date.now()}`, {
  headers: { 'x-pmux-token': token }, body: { event, session },
});

const IDS = ['rotate-request', 'rotate-handoff-check', 'rotate-restart', 'rotate-first-message', 'rotate-seat-item'];

const wave11 = async (inst, helpers) => {
  const results = [];
  try {
    await checks(inst, helpers, results);
  } catch (e) {
    results.push({ status: 'fail', id: 'wave11-error', what: 'the context lifecycle checks ran to the end', measured: e instanceof Error ? e.stack : String(e), expected: 'no exception' });
  }
  return results;
};

/**
 * The fresh session after a restart runs a bare `claude`: the instance's sleeping stand-in. For this check it
 * draws a composer and keeps its input in `sink` when `switchFile` names one; otherwise it behaves as before.
 * The original is restored when the check ends.
 */
const installRotationStandIn = (scratch, home, switchFile) => {
  const file = path.join(scratch, 'bin', 'claude');
  const original = fs.readFileSync(file, 'utf8');
  // A pane's login shell builds PATH from /usr/bin:/bin (shell-env.ts): the scratch bin reaches the fresh
  // session's bare `claude` through the scratch HOME's profile, which no earlier wave has.
  const profile = path.join(home, '.bash_profile');
  const hadProfile = fs.existsSync(profile);
  if (!hadProfile) fs.writeFileSync(profile, `PATH=${JSON.stringify(path.join(scratch, 'bin'))}:"$PATH"\n`);
  fs.writeFileSync(file, [
    '#!/bin/bash',
    '[ "$1" = --version ] && { echo "2.1.283 (Claude Code, acceptance stand-in)"; exit 0; }',
    `sink="$(cat ${JSON.stringify(switchFile)} 2>/dev/null)"`,
    '[ -n "$sink" ] || exec sleep 3600',
    'clear',
    'rows=$(stty size 2>/dev/null | cut -d" " -f1)',
    'i=4; while [ "$i" -lt "${rows:-24}" ]; do echo; i=$((i + 1)); done',
    "printf '────────────────\\n\\342\\235\\257 \\n────────────────'",
    'stty -echo 2>/dev/null',
    'exec -a claude cat >> "$sink"',
    '',
  ].join('\n'));
  return () => {
    fs.writeFileSync(file, original);
    if (!hadProfile) fs.rmSync(profile, { force: true });
  };
};

const handoffText = (stamp, resume) => [
  `# Handoff: acc-seat · updated ${stamp}`, '',
  '## Role', '/acc-seat: the acceptance seat of story 10.', '',
  '## In flight', '| item key | state | next action | waiting on |', '| --- | --- | --- | --- |', '| acc-1 | open | rotate | none |', '',
  '## Open questions', 'none', '',
  '## Standing rules', '- Rotate only from a checked handoff. (source: lane ledger ACC 2026-11-03T00:00:00Z)', '',
  '## Decisions in the last 24 h', 'none', '',
  '## Do not', '- Touch a live seat.', '',
  '## Resume command', resume, '',
].join('\n');

const checks = async (inst, { parseJson, within, sleep, brief, readIf }, results) => {
  const check = (id, what, ok, measured, expected) => results.push(ok ? { status: 'pass', id, what } : { status: 'fail', id, what, measured, expected });
  const fail = (why) => {
    for (const id of IDS) if (!results.some((r) => r.id === id)) check(id, 'needs the earlier rotation steps', false, why, 'each earlier step passed');
  };
  const nonce = crypto.randomBytes(3).toString('hex');
  const { a: wsA } = inst.state.workspaces;
  const { scratch, home, port } = inst.state;
  const io = path.join(scratch, 'io');
  fs.mkdirSync(io, { recursive: true });
  const handoff = path.join(scratch, 'seats', nonce, 'handoff.md');
  fs.mkdirSync(path.dirname(handoff), { recursive: true });
  const composer = path.join(io, `rotate-composer-${nonce}.txt`);
  const firstSink = path.join(io, `rotate-first-${nonce}.txt`);
  const switchFile = path.join(io, 'rotate-sink');
  fs.writeFileSync(composer, '');
  const resume = `/acc-resume ${nonce}`;
  const cliToken = fs.readFileSync(path.join(home, '.purplemux', 'cli-token'), 'utf8').trim();

  const seat = parseJson((await inst.cli(['tab', 'create', '-w', wsA, '-n', `acc10-seat-${nonce}`, '-t', 'claude-code', '--no-launch',
    '--handoff', handoff, '--rotate-at', '50000'])).out);
  if (!seat?.tabId || seat.handoffPath !== handoff || seat.rotateAt !== 50000) return fail(`tab create answered ${JSON.stringify(seat)}`);
  const restore = installRotationStandIn(scratch, home, switchFile);
  try {
    await sleep(1000);
    const standIn = await inst.startLiveFixtureAgent(wsA, seat, { inputFile: composer, phase: 'rotate' });
    if (standIn.rc !== 0) return fail(`stand-in ${brief(standIn)}`);
    const sessionId = path.basename(standIn.transcriptPath, '.jsonl');
    if (!(await within(10000, async () => (await inst.cliState(wsA, seat.tabId)) === 'idle'))) return fail('the seat never reached idle');

    // AC 2: a statusline reading over the threshold at the prompt.
    const reading = await request(port, 'POST', '/api/status/statusline', {
      headers: { 'x-pmux-token': cliToken },
      body: { session_id: sessionId, context_window: { current_usage: { input_tokens: 10, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 60_000 } } },
    });
    const rotateLine = `ROTATE: bring ${handoff} up to date, then end your turn with HANDOFF-READY.`;
    const typed = await within(15000, async () => (readIf(composer) ?? '').includes(rotateLine));
    const rotateEventOf = async () => (parseJson((await inst.cli(['events', 'show', '-w', wsA, seat.tabId, '--since', '15m', '--json'])).out)?.events ?? [])
      .find((e) => e.kind === 'rotate');
    // The log records a delivery once the paste returns, just after the line reaches the composer.
    const rotateEvent = (await within(5000, async () => {
      const event = await rotateEventOf();
      return event?.deliveredAt ? event : null;
    })) || await rotateEventOf();
    check('rotate-request', 'a seat over its threshold at its prompt is sent ROTATE as one urgent event (AC 2)',
      Boolean(typed && rotateEvent && rotateEvent.class === 'urgent' && rotateEvent.deliveredAt !== null && rotateEvent.text === rotateLine),
      `statusline ${reading.status}; typed ${typed}; event ${JSON.stringify(rotateEvent ?? null)?.slice(0, 300)}`,
      `the exact ROTATE line in the composer and one rotate event, class urgent, delivered`);
    if (!typed) return fail('no ROTATE');

    // AC 6 in the instance: the seat's real file passes the CLI checker.
    fs.writeFileSync(handoff, handoffText(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), resume));
    const checked = await inst.cli(['handoff', 'check', handoff]);
    check('rotate-handoff-check', 'purplemux handoff check passes the seat\'s real handoff file (AC 6)',
      checked.rc === 0 && checked.out === `handoff-check: PASS ${handoff}\n`, brief(checked), `exit 0, handoff-check: PASS ${handoff}`);

    // AC 3: the turn ends with HANDOFF-READY.
    fs.writeFileSync(switchFile, firstSink);
    await hookAt(inst, cliToken, 'prompt-submit', seat.sessionName);
    await within(10000, async () => (await inst.cliState(wsA, seat.tabId)) === 'busy');
    fs.appendFileSync(standIn.transcriptPath, `${JSON.stringify({
      type: 'assistant', timestamp: new Date().toISOString(),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `Brought ${handoff} up to date.\n\nHANDOFF-READY` }] },
    })}\n`);
    const stopAt = Date.now();
    await hookAt(inst, cliToken, 'stop', seat.sessionName);
    const auditFile = path.join(home, '.purplemux', 'audit', 'coordination.jsonl');
    const restartLine = await within(60000, async () => (readIf(auditFile) ?? '').split('\n').filter(Boolean).map((l) => parseJson(l))
      .find((l) => l?.event === 'tab-restart' && l.tabId === seat.tabId && l.clear === true && l.by?.kind === 'server' && l.outcome === 'restarted'));
    const listed = parseJson((await inst.cli(['tab', 'list', '-w', wsA])).out)?.tabs?.find((t) => t.tabId === seat.tabId);
    const statusAfter = restartLine ? null : (await inst.cli(['tab', 'status', '-w', wsA, seat.tabId])).out;
    check('rotate-restart', 'HANDOFF-READY with a passing file restarts the seat --clear by the server, under the same tab id (AC 3)',
      Boolean(restartLine && listed && listed.handoffPath === handoff),
      `audit ${JSON.stringify(restartLine ?? null)}; tab ${JSON.stringify(listed ?? null)?.slice(0, 200)}; ${Date.now() - stopAt} ms after the stop${statusAfter ? `; status ${statusAfter.replace(/\s+/g, ' ').slice(0, 900)}` : ''}`,
      'one tab-restart audit line, clear true, by server, outcome restarted; the same tab id listed with its handoff path');
    if (!restartLine) return fail('no restart');

    // The fresh session announces itself; the first message is typed once it is idle.
    await within(15000, async () => fs.existsSync(firstSink) || (await inst.cliState(wsA, seat.tabId)) !== null);
    await sleep(1500);
    await hookAt(inst, cliToken, 'session-start', seat.sessionName);
    const firstLine = `Read ${handoff}, then continue: ${resume}`;
    const first = await within(45000, async () => (readIf(firstSink) ?? '').includes(firstLine));
    const pane = first ? '' : (await inst.captureIsolatedPane(seat.sessionName)).trim().slice(-600);
    check('rotate-first-message', 'the fresh session\'s first message is "Read <path>, then continue: <resume command>" (AC 3)',
      first, `first session input ${JSON.stringify((readIf(firstSink) ?? '').slice(0, 300))}; pane ${JSON.stringify(pane)}`, JSON.stringify(firstLine));

    // The seat leaves `rotating` once the first message is typed: the write follows the paste.
    const seatItem = async () => (parseJson((await inst.cli(['ledger', 'show', '-w', wsA, '--type', 'seat', '--json'])).out)?.items ?? [])
      .find((i) => i.itemKey === `seat:${wsA}:acc10-seat-${nonce}`);
    const item = (await within(10000, async () => {
      const found = await seatItem();
      return found?.state === 'watching' ? found : null;
    })) || await seatItem();
    check('rotate-seat-item', 'the seat item records the reading and the rotation (AC 5)',
      Boolean(item && item.holder === `acc10-seat-${nonce}` && item.state === 'watching' && item.attrs?.rotations === 1 && item.attrs?.rotateAtTokens === 50000),
      JSON.stringify(item ?? null)?.slice(0, 400), `seat:${wsA}:acc10-seat-${nonce}, holder the tab name, state watching, rotations 1, rotateAtTokens 50000`);
  } finally {
    restore();
    fs.rmSync(switchFile, { force: true });
    await inst.cli(['tab', 'close', '-w', wsA, seat.tabId]);
  }
};

module.exports = { wave11 };
