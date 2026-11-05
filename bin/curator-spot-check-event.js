'use strict';

// The spot-check item as `purplemux curator spot-check open` posts it (ADR-0038; story 16 consult): the run's
// attention.opened at revision 0 (a new item), with the owner review that makes it visible. Shared with the tests,
// which post it through the real Mission Control store.

const spotCheckEvent = ({ draft, run, workspaceId, task, now }) => ({
  type: 'attention.opened',
  eventId: `curator:${draft.itemId}`,
  schemaVersion: 1,
  workspaceId,
  runId: run.runId,
  expectedRevision: 0,
  producerAt: now,
  bindingGeneration: run.bindingGeneration,
  payload: {
    itemId: draft.itemId,
    ...draft.question,
    humanReview: {
      humanNeed: 'decision',
      humanReason: task === 'classify-owner-message'
        ? 'Only the owner can say whether these labels of their own messages are right.'
        : 'Only the owner can say whether these asks were really covered by the standing order.',
      handling: `The curator gate reads this answer before ${task} may route.`,
      reviewerTabId: run.tabId,
    },
  },
});

module.exports = { spotCheckEvent };
