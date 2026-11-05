'use strict';
// Wave-9 acceptance checks (story 12): the owner board and the pulse through the candidate's
// production build. The pulse answers every workspace with 48 hourly bars and each source's own
// state, the CLI prints it, the orchestrator's tab sets a goal the board forecasts, and the board
// keeps the fields story 08's status push reads. The page itself is wave 7's.
//
// `wave10(inst, helpers)` returns results in checks.cjs's shape: { status, id, what, measured?, expected? }.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PULSE_SOURCES = ['ledger', 'commits', 'gates', 'reviews', 'landed', 'answers'];
const SCREENSHOT_WIDTHS = [390, 1280];
/** The board fetches its data in the browser (SWR); this long after load, the pulse rows are drawn. */
const SETTLE_MS = 6000;
const CHROME = process.env.ACCEPT_HEADLESS_CHROME || path.join(os.homedir(), '.local', 'bin', 'headless-chrome');
const STALL_STATES = ['stalled', 'moving', 'steady', 'idle', 'not-measured'];

/** Every way a served pulse breaks the contract; empty when it holds. */
const pulseDefects = (pulse) => {
  const defects = [];
  if (!pulse || typeof pulse !== 'object') return ['no pulse'];
  if (pulse.hours !== null && (!Array.isArray(pulse.hours) || pulse.hours.length !== 48)) defects.push(`hours: ${Array.isArray(pulse.hours) ? pulse.hours.length : typeof pulse.hours}, expected 48 or null`);
  // Shared sources (round 2, F1) follow the six counted ones; they are shown, never counted.
  const ids = (pulse.sources ?? []).filter((source) => !source.sharedWith).map((source) => source.id);
  if (JSON.stringify(ids) !== JSON.stringify(PULSE_SOURCES)) defects.push(`sources: ${JSON.stringify(ids)}, expected ${JSON.stringify(PULSE_SOURCES)}`);
  for (const source of pulse.sources ?? []) {
    if (source.state === 'unknown' && (source.count !== null || !source.reason)) defects.push(`${source.id}: unknown with count ${source.count} and reason ${source.reason}`);
    if (source.state === 'ok' && !Number.isInteger(source.count)) defects.push(`${source.id}: ok with count ${source.count}`);
    if (!['ok', 'unknown'].includes(source.state)) defects.push(`${source.id}: state ${source.state}`);
  }
  if (!STALL_STATES.includes(pulse.stall?.state)) defects.push(`stall.state: ${pulse.stall?.state}`);
  if (!['ledger', 'agent-tabs', 'none'].includes(pulse.wip?.basis)) defects.push(`wip.basis: ${pulse.wip?.basis}`);
  if (typeof pulse.priority?.text !== 'string' || !pulse.priority.text) defects.push('priority.text missing');
  return defects;
};

/** A minimal DevTools-protocol client over the browser's websocket: send() resolves with the result. */
const cdpClient = (url) => new Promise((resolve, reject) => {
  const WebSocket = require('ws');
  const socket = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const events = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id && pending.has(message.id)) {
      const { ok, fail } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) fail(new Error(`${message.error.message} (${message.error.code})`));
      else ok(message.result);
    } else if (message.method) events.push(message);
  });
  socket.on('error', reject);
  socket.on('open', () => resolve({
    send: (method, params = {}, sessionId) => new Promise((ok, fail) => {
      id += 1;
      pending.set(id, { ok, fail });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    }),
    sawEvent: (method) => events.some((event) => event.method === method),
    close: () => socket.close(),
  }));
});

/** Start headless Chrome on a free DevTools port; resolves with its process and websocket URL. */
const startChrome = () => new Promise((resolve, reject) => {
  const child = spawn(CHROME, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let text = '';
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(`headless-chrome printed no DevTools URL in 20 s: ${text.slice(-200)}`));
  }, 20000);
  child.stderr.on('data', (chunk) => {
    text += String(chunk);
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
    if (match) {
      clearTimeout(timer);
      resolve({ child, url: match[1] });
    }
  });
  child.on('error', (e) => {
    clearTimeout(timer);
    reject(e);
  });
});

/**
 * Real browser screenshots of the served board (story 12 round 2, F11): the candidate's own page,
 * signed in with the scratch human session, at 390 and 1280 px, full height, after the board's
 * own reads drew the pulse rows. Returns the files written and the pulse rows each one shows.
 */
const screenshotBoard = async (inst, dir) => {
  const cookie = await inst.humanCookie();
  const [name, value] = cookie.split('=');
  const { child, url } = await startChrome();
  const shots = [];
  try {
    const cdp = await cdpClient(url);
    try {
      for (const width of SCREENSHOT_WIDTHS) {
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        await cdp.send('Network.enable', {}, sessionId);
        await cdp.send('Network.setCookie', { name, value, domain: 'localhost', path: '/', httpOnly: true }, sessionId);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 }, sessionId);
        await cdp.send('Page.enable', {}, sessionId);
        await cdp.send('Page.navigate', { url: `http://localhost:${inst.state.port}/mission-control` }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        const rows = (await cdp.send('Runtime.evaluate', { expression: "document.querySelectorAll('[data-pulse-row]').length", returnByValue: true }, sessionId)).result.value;
        const { cssContentSize } = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
        const height = Math.ceil(cssContentSize?.height ?? 900);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }, sessionId);
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
        const file = path.join(dir, `board-served-${width}.png`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        shots.push({ file, width, rows, bytes: fs.statSync(file).size });
        await cdp.send('Target.closeTarget', { targetId });
      }
    } finally {
      cdp.close();
    }
  } finally {
    child.kill('SIGKILL');
  }
  return shots;
};

const wave10 = async (inst, helpers) => {
  const results = [];
  try {
    await checks(inst, helpers, results);
  } catch (e) {
    results.push({ status: 'fail', id: 'wave10-error', what: 'the board checks ran to the end', measured: e instanceof Error ? e.stack : String(e), expected: 'no exception' });
  }
  return results;
};

const checks = async (inst, { parseJson, brief }, results) => {
  const check = (id, what, ok, measured, expected) => results.push(ok
    ? { status: 'pass', id, what }
    : { status: 'fail', id, what, measured, expected });
  const { a: wsA } = inst.state.workspaces;

  const all = await inst.human('GET', '/api/mission-control/pulse?workspaceId=all');
  const pulses = all.json?.pulses ?? [];
  const defects = pulses.flatMap((pulse) => pulseDefects(pulse).map((d) => `${pulse.workspaceId}: ${d}`));
  check('board-pulse-route', 'the pulse route answers every workspace: 48 hourly bars or none, each source with its own state (never 0 for unknown)',
    all.status === 200 && pulses.some((pulse) => pulse.workspaceId === wsA) && defects.length === 0,
    `status ${all.status}; ${pulses.length} pulses; defects ${JSON.stringify(defects)}`,
    `200 with ${wsA} among the pulses and no defect`);

  const cliJson = await inst.cli(['board', 'pulse', '-w', wsA, '--json']);
  const cliText = await inst.cli(['board', 'pulse', '-w', wsA]);
  check('board-pulse-cli', 'purplemux board pulse prints the strip, the stall line, priority now and each source',
    cliJson.rc === 0 && pulseDefects(parseJson(cliJson.out)).length === 0 && cliText.rc === 0
      && /^last 48 h/m.test(cliText.out) && /^priority now: /m.test(cliText.out) && /^sources:$/m.test(cliText.out),
    `json ${brief(cliJson)}; text ${brief(cliText)}`, 'exit 0 for both; JSON without defect; text with the strip, priority and sources');

  const created = parseJson((await inst.cli(['tab', 'create', '-w', wsA, '-n', 'acc-board-goal', '-t', 'terminal'])).out);
  const tab = created?.tabId;
  const label = `Acceptance goal ${Date.now()}`;
  const set = tab ? await inst.inTab(wsA, tab, inst.tabCli(['board', 'goal', 'set', '-w', wsA, '--items', 'range:acc:1,range:acc:2', '--label', label]))
    : { rc: -1, out: '', err: 'no tab' };
  const board = parseJson((await inst.cli(['board', 'show', '-w', wsA, '--json'])).out);
  check('board-goal-set', 'a tab sets the goal with board goal set; the board names it and its items left',
    set.rc === 0 && set.out.startsWith(`goal: ${label} · `) && board?.onTrack?.goal === label && board?.onTrack?.itemsLeft !== undefined,
    `set ${brief(set)}; onTrack ${JSON.stringify(board?.onTrack)}`, `exit 0 printing "goal: ${label} · ..."; onTrack.goal ${label}`);
  const cleared = tab ? await inst.inTab(wsA, tab, inst.tabCli(['board', 'goal', 'clear', '-w', wsA])) : { rc: -1, out: '', err: 'no tab' };
  const after = parseJson((await inst.cli(['board', 'show', '-w', wsA, '--json'])).out);
  check('board-goal-clear', 'board goal clear leaves "no goal set"',
    cleared.rc === 0 && after?.onTrack?.goal === null && after?.onTrack?.reason === 'no goal set',
    `clear ${brief(cleared)}; onTrack ${JSON.stringify(after?.onTrack)}`, 'exit 0; onTrack.goal null, reason "no goal set"');
  if (tab) await inst.cli(['tab', 'close', '-w', wsA, tab]);

  if (!fs.existsSync(CHROME)) {
    results.push({ status: 'skip', id: 'board-screenshots', why: `no headless Chrome at ${CHROME} (set ACCEPT_HEADLESS_CHROME)` });
  } else {
    const workspaces = (all.json?.pulses ?? []).length;
    let shots = [];
    let error = '';
    try {
      shots = await screenshotBoard(inst, path.join(inst.fixtureEvidenceDir, 'board'));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    check('board-screenshots', 'a real browser renders the served board at 390 and 1280 px with a pulse row for every workspace',
      !error && shots.length === 2 && shots.every((shot) => shot.rows === workspaces && shot.bytes > 10000),
      error || JSON.stringify(shots), `2 PNGs over 10 kB, each with ${workspaces} pulse rows`);
  }

  const needsYou = after?.needsYou;
  check('board-status-push-shape', 'the board keeps the fields story 08 reads: inputs.ledger.state, onTrack.goal, needsYou rows with blocked',
    typeof after?.inputs?.ledger?.state === 'string' && 'goal' in (after?.onTrack ?? {})
      && (needsYou === null || (Array.isArray(needsYou) && needsYou.every((row) => typeof row.id === 'string' && 'blocked' in row && Number.isFinite(row.createdAt)))),
    `inputs.ledger ${JSON.stringify(after?.inputs?.ledger)}; needsYou ${JSON.stringify(needsYou)?.slice(0, 200)}`,
    'ledger.state a string; onTrack.goal present; needsYou null or rows with id, createdAt and blocked');

};

module.exports = { wave10, pulseDefects, screenshotBoard, PULSE_SOURCES };
