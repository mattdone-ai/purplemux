'use strict';
// Wave-7 acceptance checks: the Mission Control page through the candidate's production build. A
// signed-in human gets the owner board as the default view (story 12 AC 1), the Needs you answer
// list one tap away at ?view=answers, and the snapshot route that list reads answers.
//
// `wave7(inst, helpers)` returns results in checks.cjs's shape: { status, id, what, measured?, expected? }.

const NEEDS_YOU = 'id="needs-you-heading"';
const BOARD = 'data-owner-board';

/** Which view the served HTML renders: the owner board, the Needs you list, or neither; -1 when absent. */
const pageView = (html) => {
  const text = String(html);
  const needsYou = text.indexOf(NEEDS_YOU);
  const board = text.indexOf(BOARD);
  return { needsYou, board, view: board >= 0 && needsYou < 0 ? 'board' : needsYou >= 0 && board < 0 ? 'answers' : 'unknown' };
};

const wave7 = async (inst) => {
  const results = [];
  try {
    await checks(inst, results);
  } catch (e) {
    results.push({ status: 'fail', id: 'wave7-error', what: 'the Mission Control page checks ran to the end', measured: e instanceof Error ? e.stack : String(e), expected: 'no exception' });
  }
  return results;
};

const checks = async (inst, results) => {
  const check = (id, what, ok, measured, expected) => results.push(ok
    ? { status: 'pass', id, what }
    : { status: 'fail', id, what, measured, expected });

  const page = await inst.human('GET', '/mission-control');
  const shown = pageView(page.body);
  check('mission-control-board-default', 'the default Mission Control page is the owner board, with no answer list beside it',
    page.status === 200 && shown.view === 'board',
    `status ${page.status}; ${BOARD} at ${shown.board}, ${NEEDS_YOU} at ${shown.needsYou}`,
    `200 with ${BOARD} and no ${NEEDS_YOU}`);

  const answers = await inst.human('GET', '/mission-control?view=answers');
  const listed = pageView(answers.body);
  check('mission-control-needs-you-view', 'the Needs you answer list is one tap away at ?view=answers',
    answers.status === 200 && listed.view === 'answers',
    `status ${answers.status}; ${NEEDS_YOU} at ${listed.needsYou}, ${BOARD} at ${listed.board}`,
    `200 with ${NEEDS_YOU} and no ${BOARD}`);

  const snapshot = await inst.human('GET', '/api/mission-control');
  check('mission-control-needs-you-snapshot', 'the snapshot route the Needs you section reads serves items to a signed-in human',
    snapshot.status === 200 && Array.isArray(snapshot.json?.items) && Array.isArray(snapshot.json?.workspaces),
    `status ${snapshot.status}; body ${String(snapshot.body).slice(0, 200)}`,
    '200 with items[] and workspaces[]');
};

module.exports = { wave7, pageView };
