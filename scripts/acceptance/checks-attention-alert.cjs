'use strict';
// Wave-12 acceptance check (harness-flow-loop story 33, round 2): a Mission Control item that becomes
// owner-visible sends exactly ONE `attention-opened` alert through the candidate's production build,
// on the status socket the phone listens to. Two items: one opened owner-visible at once
// (`attention.opened` with a human need), one opened as a candidate and promoted by
// `attention.updated` (candidate -> open), the case that sent no alert before round 2. Each must
// alert once, naming its item and the revision a notification answers (1 and 2); a quiet interval
// after the last event shows no second alert.
//
// `waveAttentionAlert(inst, helpers)` returns results in checks.cjs's shape: { status, id, what, measured?, expected? }.

const crypto = require('crypto');

const CHECK = {
  id: 'attention-alert-once',
  what: 'an item opened owner-visible, and a candidate promoted to open, each send exactly one attention-opened alert on the status socket, naming the item and its revision',
  expected: 'status socket open; run.started, opened, candidate, promoted each exit 0; item states open/open; alerts: opened x1 at revision 1, promoted x1 at revision 2; none for any other item of this run',
};

/** How long after the last event a second alert would have arrived (the dispatcher does not wait on channels). */
const QUIET_MS = 5000;

/** Pure: the verdict over the alert frames the socket received and what the events route answered. */
const judgeAttentionAlerts = ({ socketOpen, sends, states, frames, openedId, promotedId, runPrefix }) => {
  const alerts = frames.filter((frame) => frame?.type === 'notification:alert' && frame.alert?.kind === 'attention-opened');
  const of = (itemId) => alerts.filter((frame) => frame.alert.itemId === itemId);
  const stray = alerts.filter((frame) => typeof frame.alert.itemId === 'string' && frame.alert.itemId.startsWith(runPrefix)
    && frame.alert.itemId !== openedId && frame.alert.itemId !== promotedId);
  const opened = of(openedId);
  const promoted = of(promotedId);
  const sendsOk = Object.values(sends).every((rc) => rc === 0);
  const ok = socketOpen && sendsOk && states.opened === 'open' && states.promoted === 'open'
    && opened.length === 1 && promoted.length === 1 && stray.length === 0
    && opened[0].alert.question?.revision === 1 && promoted[0].alert.question?.revision === 2;
  const revisions = (list) => list.map((frame) => frame.alert.question?.revision ?? 'none').join(',') || 'none';
  return {
    ok,
    measured: `socket ${socketOpen ? 'open' : 'closed'}; sends ${JSON.stringify(sends)}; states ${JSON.stringify(states)}; `
      + `alerts opened x${opened.length} (revision ${revisions(opened)}), promoted x${promoted.length} (revision ${revisions(promoted)}), other items of this run x${stray.length}`,
  };
};

/** The status socket as the phone holds it: the human session cookie on the upgrade. Collects every frame. */
const statusSocket = (port, cookie) => new Promise((resolve) => {
  const WebSocket = require('ws');
  const frames = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/status`, { headers: { cookie, origin: `http://localhost:${port}`, host: `localhost:${port}` } });
  const done = (open) => resolve({ open, frames, close: () => socket.close() });
  socket.on('message', (raw) => {
    try {
      frames.push(JSON.parse(String(raw)));
    } catch {
      // A frame that is not JSON is not an alert.
    }
  });
  socket.on('open', () => done(true));
  socket.on('error', () => done(false));
  setTimeout(() => done(false), 15000);
});

const waveAttentionAlert = async (inst, helpers) => {
  const results = [];
  try {
    await check(inst, helpers, results);
  } catch (e) {
    results.push({ status: 'fail', id: 'wave-attention-alert-error', what: 'the attention alert check ran to the end', measured: e instanceof Error ? e.stack : String(e), expected: 'no exception' });
  }
  return results;
};

const check = async (inst, { parseJson, within, sleep, brief }, results) => {
  const record = (ok, measured) => results.push(ok
    ? { status: 'pass', id: CHECK.id, what: CHECK.what }
    : { status: 'fail', id: CHECK.id, what: CHECK.what, measured, expected: CHECK.expected });
  const { a: wsA } = inst.state.workspaces;
  const nonce = crypto.randomBytes(3).toString('hex');
  const runId = `acc-alert-${nonce}`;
  const openedId = `${runId}-opened`;
  const promotedId = `${runId}-promoted`;

  // An owner-visible item needs a human review from the bound orchestrator (ADR-0031): a live stand-in.
  const orch = parseJson((await inst.cli(['tab', 'create', '-w', wsA, '-n', `acc-alert-orch-${nonce}`, '-t', 'claude-code', '--no-launch'])).out);
  const standIn = orch?.tabId ? await inst.startLiveFixtureAgent(wsA, orch) : { rc: -1, out: '', err: 'no tab' };
  const designated = standIn.rc === 0 ? await inst.designate(wsA, orch.tabId) : { rc: -1, out: '', err: 'no stand-in' };
  const bound = designated.rc === 0
    ? await within(150000, async () => parseJson((await inst.cli(['tab', 'status', '-w', wsA, orch.tabId])).out)?.agentSessionId ?? null)
    : null;
  if (!bound) {
    record(false, `stand-in ${brief(standIn)}; designate ${brief(designated)}; bound ${Boolean(bound)}`);
    return;
  }

  const socket = await statusSocket(inst.state.port, await inst.humanCookie());
  const send = async (event) => (await inst.cli(['mission', 'events', '-w', wsA, '--json', JSON.stringify({ events: [event] })])).rc;
  const base = (name, expectedRevision, bindingGeneration) => ({
    eventId: `${runId}-${name}`, schemaVersion: 1, workspaceId: wsA, runId, expectedRevision, producerAt: Date.now(), bindingGeneration,
  });
  const question = (itemId, title) => ({
    itemId, formatVersion: 2, kind: 'question', title, decision: `Acceptance: ${title}?`, whyNow: 'The release gate runs it.',
    answerType: 'confirm', storyIds: [], blockingScope: 'none', canContinue: true, context: 'acceptance check',
  });
  const review = { humanNeed: 'decision', humanReason: 'acceptance check', handling: 'acceptance check', reviewerTabId: orch.tabId };
  const snapshot = async () => parseJson((await inst.cli(['mission', 'snapshot', '-w', wsA])).out);
  const run = async () => (await snapshot())?.runs?.find((candidate) => candidate.id === runId) ?? null;

  const sends = {};
  sends.started = await send({ ...base('start', 0, 0), type: 'run.started', payload: { objective: `acc alert ${nonce}`, tabId: orch.tabId } });
  const generation = (await within(30000, async () => (await run())?.binding?.generation ?? null)) ?? 1;
  sends.opened = await send({ ...base('opened', 0, generation), type: 'attention.opened', payload: { ...question(openedId, 'Opened for you'), humanReview: review } });
  sends.candidate = await send({ ...base('candidate', 0, generation), type: 'attention.opened', payload: question(promotedId, 'Reviewed later') });
  sends.promoted = await send({ ...base('promoted', 1, generation), type: 'attention.updated', payload: { ...question(promotedId, 'Reviewed later'), humanReview: review } });
  await sleep(QUIET_MS);
  socket.close();

  const items = (await snapshot())?.items ?? [];
  const stateOf = (id) => items.find((item) => item.id === id)?.state ?? 'none';
  const states = { opened: stateOf(openedId), promoted: stateOf(promotedId) };
  // Leave nothing open for a later wave or a kept instance.
  for (const item of items.filter((candidate) => candidate.id === openedId || candidate.id === promotedId)) {
    await send({ ...base(`cancel-${item.id}`, item.revision, generation), type: 'attention.cancelled', payload: { itemId: item.id, reason: 'acceptance cleanup' } });
  }
  const current = await run();
  if (current) await send({ ...base('finish', current.revision, generation), type: 'run.finished', payload: { state: 'completed', summary: 'acceptance done', closeoutPending: false } });

  const judged = judgeAttentionAlerts({ socketOpen: socket.open, sends, states, frames: socket.frames, openedId, promotedId, runPrefix: runId });
  record(judged.ok, judged.measured);
};

module.exports = { waveAttentionAlert, judgeAttentionAlerts, statusSocket, CHECK, QUIET_MS };
