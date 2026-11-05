import { createHash } from 'crypto';
import { normalisedOrderText } from '@/lib/curator-routing';
import { SO_PROPOSAL_ITEM_PREFIX } from '@/lib/mission-control-validation';
import { STANDING_ORDERS_MAX_BYTES } from '@/lib/standing-orders';

// A fleet standing order the selected portfolio manager proposes and the owner confirms (ADR-0041 §1 amendment D7).
// Pure: the item id, the question, the order's source, and the line the proposer reads. The runtime is
// `so-proposal-service.ts`.

export const SO_PROPOSAL_TTL_MS = 72 * 60 * 60_000;
export const PROPOSAL_LIMITS = { why: 200, cites: 300 } as const;
export const YES = 'yes';
export const NO = 'no';

export const EXPIRED_REASON = 'Proposal expired after 72 h with no answer: nothing filed.';

/** 16 hex of the normalised text: two proposals of one rule share it, whatever their case or trailing punctuation. */
export const proposalTextKey = (text: string): string =>
  createHash('sha256').update(normalisedOrderText(text)).digest('hex').slice(0, 16);

/** The id prefix every proposal of the same text shares: the store finds an open one by it. */
export const proposalItemPrefix = (text: string): string => `${SO_PROPOSAL_ITEM_PREFIX}${proposalTextKey(text)}`;

/** `so-proposal-<16 hex of the normalised text><8 hex of the open time>`; the time is in seconds. */
export const proposalItemId = (text: string, at: number): string =>
  `${proposalItemPrefix(text)}${(Math.floor(at / 1000) >>> 0).toString(16).padStart(8, '0')}`;

/**
 * The filed order's source: the owner's answer is its authority; the proposer only wrote the draft. The step finds the
 * order of one answer by this exact string in the fleet file, so it is a pure function of the answer and the record.
 */
export const proposalOrderSource = (answerId: string, itemId: string, answeredAt: number, workspaceId: string, tabId: string): string =>
  `owner answer ${answerId} on MC item ${itemId} (${new Date(answeredAt).toISOString().slice(0, 10)} UTC), proposed by ${workspaceId}/${tabId}`;

/**
 * Why a Yes filed nothing (D7 rule 6, `not-filed`). The code is recorded beside the reason (`reason_code`) and in the
 * audit row with the store's message; the owner's card and the proposer's line read only the sentence below.
 */
export const NOT_FILED_CODES = ['so-too-large', 'so-unreadable', 'so-invalid', 'duplicate', 'system-actor'] as const;
export type TNotFiledCode = (typeof NOT_FILED_CODES)[number];

export interface INotFiledDetail {
  /** The largest prompt section the add would leave, and its workspace (`so-too-large`). */
  bytes?: number;
  workspaceId?: string | null;
  /** The active fleet order that already says this (`duplicate`). */
  orderId?: string;
}

const NOT_FILED_REASONS: Readonly<Record<TNotFiledCode, (detail: INotFiledDetail) => string>> = {
  'so-too-large': (d) => (d.bytes === undefined
    ? `Filing it would pass the ${STANDING_ORDERS_MAX_BYTES}-byte budget of standing orders in a prompt. Strike an order, then propose again.`
    : `Filing it would make the standing orders of ${d.workspaceId ?? 'the fleet'} ${d.bytes} bytes, past the ${STANDING_ORDERS_MAX_BYTES}-byte budget. Strike an order, then propose again.`),
  'so-unreadable': () => 'A standing-order file could not be read, so nothing was written. Repair the file, then propose again.',
  'so-invalid': () => 'The proposed order is no longer a valid order, so nothing was written.',
  duplicate: (d) => (d.orderId ? `The active fleet order ${d.orderId} already says this.` : 'An active fleet order already says this.'),
  'system-actor': () => 'The answer did not come from the owner, so nothing was written.',
};

/** The one sentence for a not-filed code; a code this release does not know gets a neutral sentence, never the code. */
export const notFiledReason = (code: string, detail: INotFiledDetail = {}): string =>
  (Object.hasOwn(NOT_FILED_REASONS, code) ? NOT_FILED_REASONS[code as TNotFiledCode](detail) : 'The order could not be filed, so nothing was written.');

export interface IProposalDraft {
  text: string;
  scope: string;
  check: string;
  why: string;
  cites: string | null;
  workspaceId: string;
  tabId: string;
}

export interface IProposalReach {
  /** The workspaces whose prompt the order reaches. */
  workspaces: number;
  /** The live agent tabs that get the order's one line. */
  liveTabs: number;
  /** The largest prompt section the add leaves, and the workspace it is for. */
  bytes: number;
  bytesWorkspace: string | null;
}

/** A fence longer than any backtick run in the text: the order quotes verbatim whatever it holds. */
const fenceFor = (text: string): string => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/** Format 2 `confirm`, class `scope`, no default and nothing recommended: only the owner's Yes files the order. */
export const buildProposalQuestion = (draft: IProposalDraft, reach: IProposalReach): Record<string, unknown> => {
  const fence = fenceFor(draft.text);
  // Every proposer-written field stays inside a fence: no markdown of the proposer reaches the owner's card.
  const details = [`scope: ${draft.scope}`, `check: ${draft.check}`, `cites: ${draft.cites ?? 'nothing cited'}`].join('\n');
  const detailsFence = fenceFor(details);
  return {
    formatVersion: 2,
    kind: 'question',
    title: clip(`Fleet standing order: ${draft.text}`, 80),
    decision: 'Add this fleet standing order? It reaches every Claude tab on this host.',
    whyNow: draft.why,
    answerType: 'confirm',
    options: [
      { id: YES, label: 'Yes, file it', consequence: 'Files the order exactly as quoted; every Claude tab loads it until it is struck.', recommended: false, needsText: false },
      { id: NO, label: 'No', consequence: 'Nothing is filed.', recommended: false, needsText: false },
    ],
    context: [
      `${fence}text`,
      draft.text,
      fence,
      '',
      'Scope, check and cited owner message, as the proposer wrote them:',
      '',
      `${detailsFence}text`,
      details,
      detailsFence,
      '',
      `- Proposed by \`${draft.workspaceId}/${draft.tabId}\`, the selected portfolio manager`,
      `- Reaches ${plural(reach.workspaces, 'workspace')} and ${plural(reach.liveTabs, 'live agent tab')}`,
      `- Largest prompt section after the add: ${reach.bytes} bytes of ${STANDING_ORDERS_MAX_BYTES}${reach.bytesWorkspace ? ` (${reach.bytesWorkspace})` : ''}`,
      '',
      'Yes files the order exactly as quoted. No, text alone, or no answer in 72 h files nothing.',
    ].join('\n'),
    storyIds: [],
    blockingScope: 'none',
    canContinue: true,
    class: 'scope',
  };
};

/** The one line the proposer reads when no answer explains the outcome (D7 rule 8). */
export const proposalOutcomeLine = (itemId: string, outcome: { expired: true } | { notFiled: string }): string =>
  `[purplemux standing order] proposal ${itemId} ${'expired' in outcome ? 'expired after 72 h' : `not filed: ${outcome.notFiled}`}: nothing filed`;
