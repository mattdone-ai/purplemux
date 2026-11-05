'use strict';
// Wave-15 acceptance checks: curator routing ships dark (story 23, ADR-0042) through the candidate's production build.
// The instance has its own HOME, so no task is promoted and no workspace opts in. The checks need no model: an owner
// message files no order and queues no rule, `mc ask --fix` posts nothing, the reshape task is in shadow with promote
// refused for its reasons, the judge's routes refuse with no evaluation, and the candidate key is checked at write.
//
// `wave15(inst, helpers)` returns results in checks.cjs's shape: { status, id, what, measured?, expected? }.

const fs = require('fs');
const path = require('path');

const RESHAPE_DRAFT = (workspaceId) => ({
  eventId: 'acc-curator-fix-1', schemaVersion: 1, workspaceId, runId: 'acc-curator-run-absent', expectedRevision: 0,
  producerAt: 1_700_000_000_000, bindingGeneration: 1, type: 'attention.opened',
  // Format 2 with an 85-character label and no whyNow: refused by the check at any min-version, so --fix runs.
  payload: {
    itemId: 'acc-curator-fix-1', formatVersion: 2, kind: 'question', title: 'Deploy window', decision: 'Pick the deploy window for the ledger change',
    answerType: 'single', context: 'Friday is quiet; tonight has a rollback ready.', storyIds: [],
    options: [
      { id: 'friday', label: 'Wait for the Friday quiet window and deploy then, after the freeze lifts for everyone', recommended: false, needsText: false },
      { id: 'tonight', label: 'Tonight', recommended: false, needsText: false },
    ],
    blockingScope: 'none', canContinue: true,
  },
});

const wave15 = async (inst, helpers) => {
  const results = [];
  try {
    await checks(inst, helpers, results);
  } catch (e) {
    results.push({ status: 'fail', id: 'wave15-error', what: 'the curator routing checks ran to the end', measured: e instanceof Error ? e.stack : String(e), expected: 'no exception' });
  } finally {
    await inst.cli(['config', 'unset', 'curator.standing-order.candidates']);
  }
  return results;
};

const checks = async (inst, { parseJson, brief, sleep }, results) => {
  const { a: wsA } = inst.state.workspaces;
  const push = (ok, id, what, measured, expected) => results.push(ok ? { status: 'pass', id, what } : { status: 'fail', id, what, measured, expected });
  const wsDir = path.join(inst.state.home, '.purplemux', 'workspaces', wsA);

  const status = parseJson((await inst.cli(['curator', 'status', '--json'])).out);
  const reshape = (status?.tasks ?? []).find((t) => t.task === 'reshape-question');
  push(reshape?.state === 'shadow' && (reshape?.gate?.refusals ?? []).some((r) => r.startsWith('no evaluation: run `purplemux curator eval --task reshape-question`')),
    'curator-reshape-shadow', 'reshape-question is a task, in shadow, and its gate names the missing evaluation',
    `reshape ${JSON.stringify(reshape ? { state: reshape.state, refusals: reshape.gate?.refusals } : null).slice(0, 400)}`, 'state shadow; a refusal "no evaluation: run `purplemux curator eval --task reshape-question`"');

  const promote = await inst.cli(['curator', 'promote', '--task', 'reshape-question']);
  push(promote.rc === 3 && promote.err.includes('curator-gate-refused') && promote.err.includes('no evaluation'),
    'curator-reshape-promote-refused', 'promote of the reshape with no evaluation, no judge and no shadow is refused with its reasons (AC 4)',
    `rc ${promote.rc} ${brief(promote.err)}`, 'rc 3 curator-gate-refused naming the missing evaluation');

  const pairs = await inst.cli(['curator', 'reshape-pairs']);
  push(pairs.rc === 3 && pairs.err.includes('no reshape evaluation'), 'curator-reshape-pairs-refused',
    'the judge\'s input is refused with no reshape evaluation', `rc ${pairs.rc} ${brief(pairs.err)}`, 'rc 3 naming the missing evaluation');

  const badKey = await inst.cli(['config', 'set', 'curator.standing-order.candidates', 'v2-scrum-master']);
  const goodKey = await inst.cli(['config', 'set', 'curator.standing-order.candidates', `${wsA}=acc-sm`]);
  push(badKey.rc === 2 && badKey.err.includes('takes ws-...=<tab name> pairs') && goodKey.rc === 0, 'curator-candidates-key',
    'the v2 candidate key takes ws=tab pairs only (consult C1)', `bad rc ${badKey.rc} ${brief(badKey.err)}; good rc ${goodKey.rc} ${brief(goodKey.err)}`,
    'bad rc 2 config-invalid; good rc 0');

  const io = path.join(inst.state.scratch, 'io');
  fs.mkdirSync(io, { recursive: true });
  const draftFile = path.join(io, 'curator-fix.json');
  fs.writeFileSync(draftFile, JSON.stringify(RESHAPE_DRAFT(wsA)));
  const fix = await inst.cli(['mc', 'ask', '-w', wsA, '--fix', '--json', `@${draftFile}`], { timeoutMs: 60000 });
  push(fix.rc === 2 && fix.err.includes('--fix: the curator reshape is in shadow here') && fix.err.includes('question defects'),
    'curator-fix-shadow', 'mc ask --fix where the reshape is in shadow prints the defects and the reason, exits 2 and posts nothing (AC 5)',
    `rc ${fix.rc} ${brief(fix.err)}`, 'rc 2; "question defects" and "--fix: the curator reshape is in shadow here"');

  const before = parseJson((await inst.cli(['so', 'list', '-w', wsA, '--json'])).out)?.orders?.length ?? null;
  const sent = await inst.human('POST', '/api/message-history', { wsId: wsA, message: 'From now on, always answer status asks with the board URL. The board must show AEDT times.' });
  await sleep(1500);
  const after = parseJson((await inst.cli(['so', 'list', '-w', wsA, '--json'])).out)?.orders?.length ?? null;
  const queued = fs.existsSync(path.join(wsDir, 'spec-queue.md'));
  push(sent.status === 201 && before !== null && after === before && !queued, 'curator-owner-message-dark',
    'an owner message is saved at once and, with nothing promoted, files no order and queues no rule (AC 1, AC 5)',
    `post ${sent.status}; orders ${before} -> ${after}; spec-queue.md ${queued ? 'exists' : 'absent'}`, 'post 201; the same order count; no spec-queue.md');
};

module.exports = { wave15, RESHAPE_DRAFT };
