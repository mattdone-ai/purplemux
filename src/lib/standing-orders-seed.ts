import type { IStandingOrder } from '@/lib/standing-orders';

// The fleet file's first contents (story 14 AC 3): the W8 orders of ADR-HFL-05 decision 4, nothing more.
// Each source is the owner message the harness audit of 2026-11-03 quoted for the cluster (its `#n` is
// the message's place by sentAt in the audit's 572), named by its `message-history.json` entry id.

const ADDED = '2026-11-03T10:00:00Z';

export const SEED_FLEET_ORDERS: readonly IStandingOrder[] = [
  {
    id: 'SO-1',
    text: 'Before you build or change a slice, read the v1 sources and tests for it, and name them in the brief and the report.',
    source: 'owner message ws-ldhziO/dgX0NKbuyiMUiRwhYQm28 (audit #124), 2026-10-22T10:40Z',
    scope: 'fleet',
    check: 'prose',
    state: 'active',
    added: ADDED,
  },
  {
    id: 'SO-2',
    text: 'Before you say data is "not available", check the data sources (Redash, Billing, v1) and name the ones you checked.',
    source: 'owner message ws-ldhziO/i5rnJ8fdYWqPHSxTe_lgw (audit #557), 2026-11-02T22:32Z',
    scope: 'fleet',
    check: 'prose',
    state: 'active',
    added: ADDED,
  },
  {
    id: 'SO-3',
    text: 'Access already granted is used, not asked for again: try it first. The owner should have to run nothing but awslogin.',
    source: 'owner message ws-ldhziO/pTHy7CSkDGsoEaxVjz2d7 (audit #513), 2026-11-02T01:07Z',
    scope: 'fleet',
    check: 'prose',
    state: 'active',
    added: ADDED,
  },
  {
    id: 'SO-4',
    text: 'Reversible work needs no approval. Dev and QA are not production.',
    source: 'owner message ws-ldhziO/8CKYBZxg5CdX90bjBgVHL (audit #244), 2026-10-27T04:41Z',
    scope: 'fleet',
    check: 'prose',
    state: 'active',
    added: ADDED,
  },
  {
    id: 'SO-5',
    text: 'Give the owner answers as a tailnet (Tailscale) URL, with times in AEDT.',
    source: 'owner messages ws-L7eUOX/VhIofxZnFLkBEMG_by-Co, 2026-10-26T02:42Z (URL) and ws-ldhziO/Mp7SJPcyV74HtKlD1cBkg, 2026-10-26T10:16Z (AEDT)',
    scope: 'fleet',
    check: 'prose',
    state: 'active',
    added: ADDED,
  },
  {
    id: 'SO-6',
    text: 'Questions for the owner go to Mission Control, never only into chat. End the turn on one line: NEEDS-DECISION: [money|irreversible|scope|bookkeeping] <question> (a) <option> (b) <option>. The tag and the options are optional. The harness opens the Mission Control item from that line: do not open a second item for it. While you wait, repeat the same line without changes. If no item can open, the harness tells the orchestrator to open it; a workspace with no orchestrator gets a push to the owner\'s devices instead.',
    source: 'owner message ws-ldhziO/xYmU5FMQanqbAfEXg3Bnb (audit #249), 2026-10-27T05:17Z',
    scope: 'fleet',
    check: 'tests/unit/lib/needs-decision.test.ts, tests/unit/lib/status-manager-turn-end.test.ts',
    state: 'active',
    added: ADDED,
  },
  {
    id: 'SO-7',
    text: 'Answer a bare status ask with `purplemux board show --line` and the board URL.',
    source: 'owner message ws-ldhziO/6WvA0iWm_5Jvj3QSS9r4B (audit #495), 2026-11-01T05:17Z',
    scope: 'fleet',
    check: 'prose',
    state: 'active',
    added: ADDED,
  },
];
