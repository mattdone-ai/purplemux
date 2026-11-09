'use strict';
// Wave-13 acceptance checks: effect counts (story 15, ADR-0035 §7) through the candidate's production build. A
// `tab send` reaches a live stand-in; its turn (prompt-submit, posted when the typed line arrives, a Bash PostToolUse
// posted as status-hook.sh posts it, stop) is written to tab_turns; `effects show` counts the send as delivered and followed, and reads every
// phone-only flag rule as not measured with null counts, never 0.
//
// `wave13(inst, helpers)` returns results in checks.cjs's shape: { status, id, what, measured?, expected? }.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { request } = require('./checks-wave4.cjs');

const IDS = ['effects-followed', 'effects-not-measured', 'effects-text'];

const wave13 = async (inst, helpers) => {
  const results = [];
  try {
    await checks(inst, helpers, results);
  } catch (e) {
    results.push({ status: 'fail', id: 'wave13-error', what: 'the effect count checks ran to the end', measured: e instanceof Error ? e.stack : String(e), expected: 'no exception' });
  }
  return results;
};

const checks = async (inst, { parseJson, within, sleep, brief }, results) => {
  const check = (id, what, ok, measured, expected) => results.push(ok ? { status: 'pass', id, what } : { status: 'fail', id, what, measured, expected });
  const fail = (why) => {
    for (const id of IDS) check(id, 'needs a live stand-in that takes a send and a recorded turn', false, why, 'the setup steps succeed');
  };
  const nonce = crypto.randomBytes(3).toString('hex');
  const { a: wsA } = inst.state.workspaces;
  const { scratch, home, port } = inst.state;
  const token = fs.readFileSync(path.join(home, '.purplemux', 'cli-token'), 'utf8').trim();
  const hook = (urlPath, body) => request(port, 'POST', urlPath, { headers: { 'x-pmux-token': token }, body });

  const worker = parseJson((await inst.cli(['tab', 'create', '-w', wsA, '-n', `acc12-${nonce}`, '-t', 'claude-code', '--no-launch'])).out);
  if (!worker?.tabId) return fail('tab create gave no tab');
  try {
    await sleep(1000);
    const inputFile = path.join(scratch, 'io', `effects-composer-${nonce}.txt`);
    fs.mkdirSync(path.dirname(inputFile), { recursive: true });
    fs.writeFileSync(inputFile, '');
    const standIn = await inst.startLiveFixtureAgent(wsA, worker, { inputFile, phase: 'effects' });
    if (standIn.rc !== 0 || !(await within(10000, async () => (await inst.cliState(wsA, worker.tabId)) === 'idle'))) {
      return fail(`stand-in ${brief(standIn)}; the tab never reached idle`);
    }
    // `tab send` exits 0 only on proof of the turn (vel-RETRO-R3): the stand-in posts its prompt-submit when the
    // typed line reaches it, as Claude's hook does on a submit, while the send still waits for that proof.
    const probe = `acc12 effect probe ${nonce}`;
    const session = worker.sessionName;
    const sending = inst.cli(['tab', 'send', '-w', wsA, worker.tabId, probe]);
    const arrived = await within(10000, async () => fs.readFileSync(inputFile, 'utf8').includes(probe));
    if (arrived) await hook('/api/status/hook', { event: 'prompt-submit', session });
    const sent = await sending;
    if (sent.rc !== 0) return fail(`tab send ${brief(sent)}; the typed line ${arrived ? 'reached' : 'never reached'} the stand-in`);
    await within(10000, async () => (await inst.cliState(wsA, worker.tabId)) === 'busy');
    const tool = await hook(`/api/status/hook?kind=tool&session=${encodeURIComponent(session)}`,
      { tool_name: 'Bash', tool_input: { command: `echo acc12 ${nonce}` }, tool_response: { exit_code: 0 } });
    await sleep(500);
    await hook('/api/status/hook', { event: 'stop', session });

    const show = async () => parseJson((await inst.cli(['effects', 'show', '-w', wsA, '--days', '1', '--json'])).out);
    const body = await within(15000, async () => {
      const read = await show();
      const send = read?.rows?.find((r) => r.component === 'tab-send');
      return send && send.followed >= 1 ? read : null;
    }) || await show();
    const send = body?.rows?.find((r) => r.component === 'tab-send');
    check(
      'effects-followed',
      'a tab send whose next turn ran Bash counts as delivered and followed, from tab_events and tab_turns (AC 1)',
      Boolean(body?.measuredSince && body.since !== null && send && send.delivered >= 1 && send.followed >= 1 && send.judged >= send.followed),
      `tool hook HTTP ${tool.status}; measuredSince ${body?.measuredSince ?? 'none'}; tab-send ${JSON.stringify(send ?? null)}`,
      'measuredSince set, the tab-send row with delivered >= 1 and followed >= 1',
    );

    const phone = (body?.rows ?? []).filter((r) => r.family === 'phone');
    const unmeasured = (body?.rows ?? []).filter((r) => r.notMeasured !== null);
    check(
      'effects-not-measured',
      'every phone-only flag rule reads not measured, and no not-measured row carries a count (never 0)',
      phone.length >= 9 && phone.every((r) => r.notMeasured) && unmeasured.every((r) => r.delivered === null && r.followed === null && r.judged === null),
      `phone rows ${phone.length}: ${JSON.stringify(phone.slice(0, 2))}; not-measured rows with a count: ${unmeasured.filter((r) => r.delivered !== null).length}`,
      'at least 9 phone rows (6 flow rules, 3 fleet flags), all with a reason and null counts',
    );

    const text = await inst.cli(['effects', 'show', '-w', wsA]);
    check(
      'effects-text',
      'effects show prints the window, the source, the measured table and the not-measured list',
      text.rc === 0 && /^effects \S+ \S+Z\.\.\S+Z: /.test(text.out) && /\nsource: fired: tab_events/.test(text.out)
        && /\ntab-send\s+notice\s+\d+/.test(text.out) && /\nnot measured:\n/.test(text.out),
      brief(text),
      'exit 0, a header line, the source line, a tab-send row and a not-measured section',
    );
  } finally {
    await inst.cli(['tab', 'close', '-w', wsA, worker.tabId]);
  }
};

module.exports = { wave13 };
