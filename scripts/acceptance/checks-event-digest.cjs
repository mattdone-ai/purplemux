'use strict';
// Wave-9 acceptance checks: the event digest and the durable tab event log (ADR-0035, story 09) through the
// candidate's production build. A worker's DONE line reaches its orchestrator's composer within 5 s of the
// stop (AC 2: measured from the stop hook to the delivery the log records, and read back from the composer);
// a CHECKPOINTED line is held as digest and arrives inside one `DIGEST <n> since <time>` message, never on its
// own; `events show` and `events wakes` serve both from ledger.sqlite.
//
// `wave9(inst, helpers)` returns results in checks.cjs's shape: { status, id, what, measured?, expected? }.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** AC 2: an urgent event reaches the tab within this long of its trigger. */
const URGENT_MAX_MS = 5000;

const wave9 = async (inst, helpers) => {
  const results = [];
  try {
    await checks(inst, helpers, results);
  } catch (e) {
    results.push({ status: 'fail', id: 'wave9-error', what: 'the event digest checks ran to the end', measured: e instanceof Error ? e.stack : String(e), expected: 'no exception' });
  }
  return results;
};

const checks = async (inst, { parseJson, within, sleep, brief, readIf }, results) => {
  const check = (id, what, ok, measured, expected) => results.push(ok ? { status: 'pass', id, what } : { status: 'fail', id, what, measured, expected });
  const ids = ['digest-urgent-5s', 'digest-held', 'events-wakes'];
  const nonce = crypto.randomBytes(3).toString('hex');
  const { a: wsA } = inst.state.workspaces;
  const tab = async (name, extra = []) => parseJson((await inst.cli(['tab', 'create', '-w', wsA, '-n', name, '-t', 'claude-code', '--no-launch', ...extra])).out);

  const orch = await tab(`acc9-orch-${nonce}`);
  await sleep(1000);
  const inputFile = path.join(inst.state.scratch, 'io', `digest-composer-${nonce}.txt`);
  fs.mkdirSync(path.dirname(inputFile), { recursive: true });
  fs.writeFileSync(inputFile, '');
  const standIn = orch ? await inst.startLiveFixtureAgent(wsA, orch, { inputFile, phase: 'digest' }) : { rc: -1, out: '', err: 'no tab' };
  const on = orch?.tabId && standIn.rc === 0 ? await inst.designate(wsA, orch.tabId) : { rc: -1, out: '', err: 'no stand-in' };
  const idle = on.rc === 0 ? await within(10000, async () => (await inst.cliState(wsA, orch.tabId)) === 'idle') : false;
  if (!idle) {
    for (const id of ids) check(id, 'needs a live, idle, designated orchestrator stand-in in workspace A', false, `stand-in ${brief(standIn)}; designate ${brief(on)}`, 'stand-in and designation exit 0, the tab idle');
    return;
  }

  const worker = async (name, transcript) => {
    const created = await tab(name, ['--reports-to', orch.tabId]);
    if (!created?.tabId) return null;
    await sleep(500);
    const started = await inst.startStandIn(created.sessionName, transcript, { workspaceDir: 'a' });
    return started.rc === 0 ? created : null;
  };
  /** Ends the worker's turn; resolves to the time the stop was posted (the trigger), or null. */
  const stopTurn = async (w) => {
    await sleep(1000);
    await inst.hook('session-start', w.sessionName);
    await inst.hook('prompt-submit', w.sessionName);
    const busy = await within(10000, async () => (await inst.cliState(wsA, w.tabId)) === 'busy');
    const triggeredAt = Date.now();
    return busy && (await inst.hook('stop', w.sessionName)) === 204 ? triggeredAt : null;
  };
  const eventsFor = async () => parseJson((await inst.cli(['events', 'show', '-w', wsA, orch.tabId, '--since', '15m', '--json'])).out)?.events ?? [];

  const doneLine = `DONE: acceptance digest ${nonce}`;
  const w1 = await worker(`acc9-done-${nonce}`, `Shipped.\n\n${doneLine}`);
  const t1 = w1 ? await stopTurn(w1) : null;
  const urgent = t1 !== null ? await within(15000, async () => (await eventsFor()).find((e) => e.text.includes(doneLine) && e.deliveredAt !== null)) : null;
  const typedDone = urgent ? await within(5000, async () => (readIf(inputFile) ?? '').includes(doneLine)) : false;
  const latency = urgent ? urgent.deliveredAt - t1 : null;
  check(
    'digest-urgent-5s',
    'a worker\'s DONE line is urgent: typed into its orchestrator within 5 s of the stop, and recorded delivered (AC 2)',
    Boolean(urgent && urgent.class === 'urgent' && urgent.kind === 'turn-marker' && typedDone && latency !== null && latency <= URGENT_MAX_MS),
    urgent ? `class ${urgent.class}, kind ${urgent.kind}, delivered +${latency} ms after the stop, in the composer: ${typedDone}` : `worker ${w1 ? 'started' : 'not started'}, stop ${t1 !== null ? 'posted' : 'not posted'}, no delivered event`,
    `class urgent, kind turn-marker, delivered within ${URGENT_MAX_MS} ms, the line in the composer`,
  );

  const checkpointLine = `CHECKPOINTED: acceptance handoff ${nonce}`;
  const w2 = await worker(`acc9-cp-${nonce}`, `Paused.\n\n${checkpointLine}`);
  const t2 = w2 ? await stopTurn(w2) : null;
  // An orchestrator at its prompt with no digest in the last 15 min gets its digest at once; one that had a
  // digest since (another worker's turn-ended, say) keeps the event pending, which is the rule too.
  const recorded = t2 !== null ? await within(10000, async () => (await eventsFor()).find((e) => e.text.includes(checkpointLine))) : null;
  const held = recorded ? (await within(30000, async () => (await eventsFor()).find((e) => e.text.includes(checkpointLine) && e.deliveredAt !== null))) || recorded : null;
  const earlierDigest = (await eventsFor()).some((e) => e.digestId && held && e.digestId !== held.digestId && e.deliveredAt > Date.now() - 15 * 60_000);
  const composer = readIf(inputFile) ?? '';
  const at = composer.indexOf(checkpointLine);
  const inDigest = at > 0 && composer.lastIndexOf('DIGEST ', at) >= 0 && composer.lastIndexOf('DIGEST ', at) > composer.lastIndexOf(doneLine);
  const delivery = held?.deliveredAt != null ? (typeof held.digestId === 'string' && inDigest) : (earlierDigest && at < 0);
  check(
    'digest-held',
    'a CHECKPOINTED line is digest: it reaches the idle orchestrator only inside a "DIGEST <n> since" message, never on its own (AC 3)',
    // A bare nudge starts with the watchdog prefix; inside a digest the line has it dropped.
    Boolean(held && held.class === 'digest' && delivery && !composer.includes(`[orchestrator-watchdog] worker ${w2.tabId}`)),
    held ? `class ${held.class}, digest ${held.digestId ?? 'none yet'}, delivered ${held.deliveredAt != null}, inside a DIGEST in the composer ${inDigest}, an earlier digest within 15 min ${earlierDigest}` : `worker ${w2 ? 'started' : 'not started'}, stop ${t2 !== null ? 'posted' : 'not posted'}, no event recorded`,
    'class digest; delivered with a digestId inside a DIGEST message, or still held because the tab had a digest inside 15 min; never a bare nudge',
  );

  const wakes = parseJson((await inst.cli(['events', 'wakes', '-w', wsA, '--since', '15m', '--json'])).out);
  const row = wakes?.rows?.find((r) => r.tabId === orch.tabId);
  check(
    'events-wakes',
    'events wakes counts the orchestrator\'s urgent delivery and its digest as two wakes (AC 6)',
    Boolean(wakes?.hasEvents && row && row.urgent >= 1 && row.digests >= 1 && row.wakes === row.urgent + row.digests),
    `body ${JSON.stringify(wakes)?.slice(0, 300)}`,
    `a row for ${orch.tabId} with urgent >= 1, digests >= 1, wakes = urgent + digests`,
  );
};

module.exports = { wave9 };
