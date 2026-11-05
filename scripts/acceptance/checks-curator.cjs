'use strict';
// Wave-14 acceptance checks: the local curator (ADR-0038, story 16) through the candidate's production build.
// The instance has its own HOME, so it holds no labelled set and no evaluation: every task is in shadow, promote
// is refused with its reasons, and an evaluation names the missing set. `curator.enabled off` makes the board say
// "curator down" on the text board and the one line without depending on the live tunnel; the key is unset after.
//
// `wave14(inst, helpers)` returns results in checks.cjs's shape: { status, id, what, measured?, expected? }.

const TASKS = ['classify-owner-message', 'flag-owner-question', 'match-standing-order', 'reshape-question'];

const wave14 = async (inst, helpers) => {
  const results = [];
  try {
    await checks(inst, helpers, results);
  } catch (e) {
    results.push({ status: 'fail', id: 'wave14-error', what: 'the curator checks ran to the end', measured: e instanceof Error ? e.stack : String(e), expected: 'no exception' });
  } finally {
    await inst.cli(['config', 'unset', 'curator.enabled']);
  }
  return results;
};

const checks = async (inst, { parseJson, brief }, results) => {
  const { a: wsA } = inst.state.workspaces;
  const push = (ok, id, what, measured, expected) => results.push(ok ? { status: 'pass', id, what } : { status: 'fail', id, what, measured, expected });

  const status = await inst.cli(['curator', 'status', '--json']);
  const body = parseJson(status.out);
  const states = (body?.tasks ?? []).map((t) => `${t.task}:${t.state}`);
  push(status.rc === 0 && body?.model === 'gemma4:26b' && JSON.stringify(states) === JSON.stringify(TASKS.map((t) => `${t}:shadow`))
    && Number.isFinite(body?.liveSince) && ['up', 'down', 'unknown'].includes(body?.health?.state),
  'curator-status', 'curator status: gemma4:26b, the four tasks in shadow, the shadow clock started at server start',
  `rc ${status.rc} model ${body?.model} tasks ${states.join(',')} liveSince ${body?.liveSince} health ${body?.health?.state} ${brief(status.err)}`,
  'rc 0, gemma4:26b, every task shadow, liveSince a time, health up|down|unknown');

  const promote = await inst.cli(['curator', 'promote', '--task', 'flag-owner-question']);
  push(promote.rc === 3 && promote.err.includes('curator-gate-refused') && /shadow has not started for foq-v1-[0-9a-f]{8}/.test(promote.err)
    && promote.err.includes('needs n >= 30') && promote.err.includes('no evaluation'),
  'curator-promote-refused', 'promote with no shadow of the live prompt, no shadow rows and no evaluation is refused with every reason (AC 5, amended)',
  `rc ${promote.rc} ${brief(promote.err)}`, 'rc 3 curator-gate-refused naming the version clock, the 30 shadow rows and the missing evaluation');

  const evaluation = await inst.cli(['curator', 'eval', '--task', 'classify-owner-message', '--no-wait']);
  push(evaluation.rc === 3 && evaluation.err.includes('no labelled set for classify-owner-message'),
    'curator-eval-no-set', 'an evaluation with no labelled set names it, and starts nothing',
    `rc ${evaluation.rc} ${brief(evaluation.err)}`, 'rc 3 naming the missing set');

  const spot = await inst.cli(['curator', 'spot-check', 'show']);
  push(spot.rc === 0 && spot.out.trim() === 'spot check (not opened): unanswered', 'curator-spot-check-unopened',
    'the spot check reads unanswered before it is opened', `rc ${spot.rc} ${brief(spot.out)} ${brief(spot.err)}`, 'spot check (not opened): unanswered');

  const refused = await inst.cli(['config', 'set', 'curator.routing.workspaces', 'treasury-v2']);
  push(refused.rc === 2 && refused.err.includes('takes workspace ids'), 'curator-routing-key', 'routing opts in by workspace id only (AC 3)',
    `rc ${refused.rc} ${brief(refused.err)}`, 'rc 2 config-invalid');

  const off = await inst.cli(['config', 'set', 'curator.enabled', 'off']);
  const text = await inst.cli(['board', 'show', '-w', wsA]);
  const line = await inst.cli(['board', 'show', '-w', wsA, '--line']);
  push(off.rc === 0 && text.rc === 0 && /^curator: curator down \(switched off \(curator\.enabled=off\)\); the rules route · /m.test(text.out)
    && line.rc === 0 && line.out.trimEnd().endsWith(' · curator down'),
  'curator-down-board', 'with the curator down, the board says "curator down" and the rules route; the one line ends with it (AC 8)',
  `set rc ${off.rc}; board rc ${text.rc} ${brief(text.out.split('\n').find((l) => l.startsWith('curator:')) ?? 'no curator line')}; line ${brief(line.out)}`,
  'curator: curator down (...); the rules route · ... and a line ending " · curator down"');
};

module.exports = { wave14 };
