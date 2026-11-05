'use strict';
// Wave-8 acceptance checks: Mission Control question format v2 (ADR-0037) through the candidate's
// production build. `mc ask` refuses an unreadable question with every defect and exits 2 before it
// posts, `--fix` says a one-option draft needs a structural fix no reshape makes (story 23), a readable question passes the check and
// reaches the events route, and the events route itself answers 400 question-invalid.
//
// `wave8(inst, helpers)` returns results in checks.cjs's shape: { status, id, what, measured?, expected? }.

const fs = require('fs');
const path = require('path');

const RESHAPE_REASON = 'not reshaped: a reshape changes wording only, and these need a structural fix';
const ONE_OPTION_DEFECT = 'options: 1 option on answerType single, needs 2-4';

/** One attention.opened event for `mc ask`; `options` decides whether the question is readable. */
const askDraft = (workspaceId, runId, options) => ({
  eventId: `acc-mc-ask-${options.length}`, schemaVersion: 1, workspaceId, runId, expectedRevision: 0,
  producerAt: 1_700_000_000_000, bindingGeneration: 1, type: 'attention.opened',
  payload: {
    itemId: `acc-mc-ask-${options.length}`, formatVersion: 2, kind: 'question', title: 'Acceptance question',
    decision: 'Does the acceptance gate refuse an unreadable question?', whyNow: 'It runs before every deploy.',
    answerType: 'single', options, storyIds: [], blockingScope: 'none', canContinue: true,
  },
});

const READABLE = [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }];
const UNREADABLE = [{ id: 'yes', label: 'Yes' }];

const wave8 = async (inst) => {
  const results = [];
  try {
    await checks(inst, results);
  } catch (e) {
    results.push({ status: 'fail', id: 'wave8-error', what: 'the question format v2 checks ran to the end', measured: e instanceof Error ? e.stack : String(e), expected: 'no exception' });
  }
  return results;
};

const checks = async (inst, results) => {
  const check = (id, what, ok, measured, expected) => results.push(ok
    ? { status: 'pass', id, what }
    : { status: 'fail', id, what, measured, expected });
  const { a: wsA } = inst.state.workspaces;
  const dir = path.join(inst.state.scratch, 'io');
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, content) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(content));
    return file;
  };
  const runId = 'acc-mc-question-run-absent';

  const refused = await inst.cli(['mc', 'ask', '-w', wsA, '--json', `@${write('unreadable.json', askDraft(wsA, runId, UNREADABLE))}`]);
  check('mc-ask-refuses-defects', 'mc ask prints every defect and exits 2 before it posts an unreadable question',
    refused.rc === 2 && String(refused.err).includes(ONE_OPTION_DEFECT) && String(refused.err).includes('question-invalid'),
    `rc ${refused.rc}; stderr ${String(refused.err).slice(0, 300)}`, `rc 2; stderr names "${ONE_OPTION_DEFECT}"`);

  const fix = await inst.cli(['mc', 'ask', '-w', wsA, '--fix', '--json', `@${write('unreadable-fix.json', askDraft(wsA, runId, UNREADABLE))}`]);
  check('mc-ask-fix-unavailable', 'mc ask --fix prints the defects and why no reshape can fix them, and exits 2 with nothing posted',
    fix.rc === 2 && String(fix.err).includes(ONE_OPTION_DEFECT) && String(fix.err).includes(RESHAPE_REASON),
    `rc ${fix.rc}; stderr ${String(fix.err).slice(0, 300)}`, `rc 2; stderr names the defect and "${RESHAPE_REASON}"`);

  // No run exists under this ID, so a question that passes the check is refused by the events route as 404 (exit 7).
  const readable = await inst.cli(['mc', 'ask', '-w', wsA, '--json', `@${write('readable.json', askDraft(wsA, runId, READABLE))}`]);
  check('mc-ask-posts-readable', 'mc ask passes a readable question through the check to the events route',
    readable.rc === 7 && !String(readable.err).includes('question defects') && String(readable.err).includes(`run ${runId} not found`),
    `rc ${readable.rc}; stderr ${String(readable.err).slice(0, 300)}`, `rc 7 from the events route (run ${runId} not found), no defects`);

  const direct = await inst.cli(['mission', 'events', '-w', wsA, '--json', JSON.stringify({ events: [askDraft(wsA, runId, UNREADABLE)] })]);
  check('events-route-question-invalid', 'the events route refuses an unreadable question with question-invalid and lists the defect',
    direct.rc === 2 && String(direct.err).includes('question-invalid') && String(direct.err).includes(ONE_OPTION_DEFECT),
    `rc ${direct.rc}; stderr ${String(direct.err).slice(0, 300)}`, `rc 2; stderr names question-invalid and "${ONE_OPTION_DEFECT}"`);
};

module.exports = { wave8, askDraft, READABLE, UNREADABLE, ONE_OPTION_DEFECT, RESHAPE_REASON };
