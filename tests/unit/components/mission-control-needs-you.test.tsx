import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import type { NextRouter } from 'next/router';
import MissionControlNeedsYou, { needsYouClassGroups, needsYouGroups } from '@/components/features/mission-control/mission-control-needs-you';
import { createMissionDraft } from '@/components/features/mission-control/mission-control-utils';
import type { IMissionDraft } from '@/components/features/mission-control/mission-control-utils';
import MissionControlPage from '@/pages/mission-control';
import { MissionControlDeliveryCard } from '@/components/features/mission-control/mission-control-answer-card';
import type {
  IMissionAnswer,
  IMissionAttentionItem,
  IMissionAutoAnsweredItem,
  IMissionSnapshot,
  IMissionWorkspaceView,
} from '@/types/mission-control';

const now = 5_000_000;

const question = (over: Partial<IMissionAttentionItem> = {}): IMissionAttentionItem => ({
  id: 'q-1',
  workspaceId: 'ws-pay',
  runId: 'run-1',
  revision: 1,
  state: 'open',
  kind: 'question',
  title: 'Choose a release path',
  context: 'The deployment is ready for a decision.',
  storyIds: [],
  options: [{ id: 'staged', label: 'Staged rollout' }, { id: 'all', label: 'All tenants' }],
  recommendation: null,
  blockingScope: 'story',
  canContinue: true,
  evidence: { source: 'agent', sourceId: 'event-1', observedAt: now, confidence: 'confirmed' },
  answerId: null,
  resolution: null,
  humanReview: {
    humanNeed: 'decision',
    humanReason: 'Only the owner can accept the product risk.',
    handling: 'The orchestrator checked the rollout plan.',
    reviewerTabId: 'tab-1',
    binding: { tabId: 'tab-1', providerId: 'codex', sessionId: 'session-1', generation: 1, runtimeGeneration: 'launch-1' },
    eventId: 'event-review-1',
    reviewedAt: now,
  },
  candidateReason: null,
  class: null,
  defaultOptionId: null,
  autoAnswer: null,
  evidenceLinks: [],
  lint: [],
  changes: null,
  createdAt: now - 60_000,
  updatedAt: now,
  ...over,
});

const workspace = (workspaceId: string, name: string): IMissionWorkspaceView => ({
  workspaceId,
  name,
  orphaned: false,
  activity: 'active',
  agents: [],
  runIds: [],
  openItems: 0,
  awaitingAcknowledgement: 0,
  lastActivityAt: now,
  lastProgressAt: now,
  stale: false,
  evidence: { source: 'harness', sourceId: workspaceId, observedAt: now, confidence: 'confirmed' },
});

const snapshot = (items: IMissionAttentionItem[]): IMissionSnapshot => ({
  schemaVersion: 1,
  cursor: 4,
  generatedAt: now,
  workspaces: [workspace('ws-pay', 'Payments'), workspace('ws-tre', 'Treasury')],
  runs: [],
  items,
  answers: [],
  deliveries: [],
  recentEvents: [],
  bootstrap: null,
});

const draftsFor = (items: IMissionAttentionItem[]): Record<string, IMissionDraft> =>
  Object.fromEntries(items.filter((item) => item.state === 'open').map((item) => [item.id, createMissionDraft(item)]));

const render = (props: Partial<Parameters<typeof MissionControlNeedsYou>[0]>) => renderToStaticMarkup(
  <MissionControlNeedsYou
    snapshot={null}
    loading={false}
    unsupported={false}
    error={null}
    refreshing={false}
    drafts={{}}
    onRetry={() => {}}
    onDraftChange={() => {}}
    onAdoptCurrent={() => {}}
    onSubmit={() => {}}
    {...props}
  />,
);

describe('Needs you on the Mission Control answers view', () => {
  it('?view=answers shows Needs you, one tap from the board, with the view links and Mission records', () => {
    const router = { pathname: '/mission-control', asPath: '/mission-control?view=answers', query: { view: 'answers' }, push: async () => true } as unknown as NextRouter;
    const html = renderToStaticMarkup(
      <RouterContext.Provider value={router}><MissionControlPage /></RouterContext.Provider>,
    );

    expect(html.indexOf('id="needs-you-heading"')).toBeGreaterThan(-1);
    expect(html).toContain('Loading the questions that need you');
    expect(html).toContain('href="/mission-control?view=board"');
    expect(html).toContain('Mission records');
    expect(html).not.toContain('>Portfolio board</h1>');
    expect(html).not.toContain('>Mission Control</h1>');
  });

  it('?item=<id> rings that item\'s card and says so when it is no longer open', () => {
    const items = [question({ id: 'pay-1', title: 'Pay question' }), question({ id: 'done', state: 'answered', title: 'Done already', answerId: 'a-1' })];
    const ringed = render({ snapshot: snapshot(items), drafts: draftsFor(items), focusItemId: 'pay-1' });
    expect(ringed).toMatch(/id="mission-item-pay-1" data-mission-item="pay-1" class="[^"]*ring-2/);
    expect(ringed).not.toContain('data-focus-missing');
    const gone = render({ snapshot: snapshot(items), drafts: draftsFor(items), focusItemId: 'done' });
    expect(gone).toContain('data-focus-missing="done"');
    expect(gone).toContain('&quot;Done already&quot; no longer needs an answer here (answered).');
  });

  it('shows every confirmed question as an answer card, grouped by workspace, oldest first, with a count', () => {
    const items = [
      question({ id: 'pay-new', title: 'Pay newer question', createdAt: now - 10_000 }),
      question({ id: 'tre-old', workspaceId: 'ws-tre', title: 'Treasury oldest question', createdAt: now - 90_000 }),
      question({ id: 'pay-old', title: 'Pay older question', createdAt: now - 50_000 }),
      question({ id: 'candidate', state: 'candidate', title: 'Candidate only', humanReview: null, candidateReason: 'historical-context' }),
      question({ id: 'handled', title: 'Orchestrator handles this',
        humanReview: { ...question().humanReview!, humanNeed: 'none' } }),
      question({ id: 'answered', state: 'answered', title: 'Already answered', answerId: 'answer-1' }),
    ];
    const html = render({ snapshot: snapshot(items), drafts: draftsFor(items) });

    expect(html).toMatch(/Needs you<\/h2><span[^>]*>3<\/span>/);
    expect(html).toContain('Only the owner can accept the product risk.');
    expect(html).toContain('Staged rollout');
    for (const hidden of ['Candidate only', 'Orchestrator handles this', 'Already answered']) {
      expect(html).not.toContain(hidden);
    }
    const order = ['Treasury oldest question', 'Pay older question', 'Pay newer question'].map((title) => html.indexOf(title));
    expect(order.every((position) => position > -1)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(html.indexOf('>Treasury</p>')).toBeLessThan(html.indexOf('>Payments</p>'));
  });

  it('shows the empty state with a zero count when nothing needs an answer', () => {
    const html = render({ snapshot: snapshot([question({ state: 'answered', answerId: 'answer-1' })]) });

    expect(html).toContain('No confirmed questions need an answer.');
    expect(html).toMatch(/Needs you<\/h2><span[^>]*>0<\/span>/);
  });

  it('shows a loading state without a count before the first snapshot', () => {
    const html = render({ loading: true });

    expect(html).toContain('role="status"');
    expect(html).toContain('Loading the questions that need you');
    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toMatch(/Needs you<\/h2><span/);
    expect(html).not.toContain('No confirmed questions need an answer.');
  });

  it('shows the read error with Retry when no snapshot has loaded', () => {
    const html = render({ error: 'mission-control storage unavailable' });

    expect(html).toContain('role="alert"');
    expect(html).toContain('Questions could not load: mission-control storage unavailable.');
    expect(html).toContain('Retry');
    expect(html).not.toContain('No confirmed questions need an answer.');
  });

  it('says so when the server has no Mission Control API', () => {
    const html = render({ unsupported: true });

    expect(html).toContain('does not expose the Mission Control API');
    expect(html).toContain('Retry');
    expect(html).not.toContain('role="alert"');
  });

  it('keeps the last snapshot on screen when a refresh fails', () => {
    const items = [question()];
    const html = render({ snapshot: snapshot(items), drafts: draftsFor(items), error: 'connection reset' });

    expect(html).toContain('Live refresh failed: connection reset. Showing the last confirmed snapshot.');
    expect(html).toContain('Choose a release path');
  });

  it('stacks into one column at phone width', () => {
    const items = [question()];
    const loaded = render({ snapshot: snapshot(items), drafts: draftsFor(items) });
    const failed = render({ error: 'boom' });

    expect(loaded).toContain('grid min-w-0 gap-3 xl:grid-cols-2');
    expect(loaded).not.toMatch(/class="[^"]*(?<![a-z]:)grid-cols-2/);
    expect(loaded).toContain('w-full sm:w-auto');
    expect(failed).toContain('flex flex-col gap-3');
    expect(failed).toContain('w-full shrink-0 sm:w-auto');
  });
});

describe('needsYouGroups', () => {
  it('orders workspaces by their oldest question and breaks ties by id', () => {
    const groups = needsYouGroups([
      question({ id: 'b', createdAt: 20 }),
      question({ id: 'a', createdAt: 20 }),
      question({ id: 'c', workspaceId: 'ws-unknown', createdAt: 10 }),
    ], [workspace('ws-pay', 'Payments')]);

    expect(groups.map((group) => [group.workspaceId, group.workspace?.name, group.items.map((item) => item.id)])).toEqual([
      ['ws-unknown', undefined, ['c']],
      ['ws-pay', 'Payments', ['a', 'b']],
    ]);
  });
});

describe('Needs you grouped by attention class (ADR-0031)', () => {
  const day = 86_400_000;
  const today = Date.UTC(2026, 9, 27, 12, 0, 0);
  const classified = [
    question({ id: 'book', title: 'Bookkeeping question', class: 'bookkeeping', defaultOptionId: 'all', createdAt: now - 90_000 }),
    question({ id: 'plain', title: 'Unclassified question', createdAt: now - 80_000 }),
    question({ id: 'scope', title: 'Scope question', class: 'scope', createdAt: now - 70_000 }),
    question({ id: 'money', title: 'Money question', class: 'money', defaultOptionId: 'staged', createdAt: now - 10_000 }),
    question({ id: 'irrev', title: 'Irreversible question', class: 'irreversible', createdAt: now - 20_000 }),
  ];

  it('orders the groups Money, Irreversible, Scope, Bookkeeping, Unclassified, money first', () => {
    const html = render({ snapshot: snapshot(classified), drafts: draftsFor(classified) });
    const headings = ['Money', 'Irreversible', 'Scope', 'Bookkeeping', 'Unclassified']
      .map((label) => html.indexOf(`data-attention-class-group="${label.toLowerCase()}"`));
    expect(headings.every((position) => position > -1)).toBe(true);
    expect(headings).toEqual([...headings].sort((left, right) => left - right));
    const titles = ['Money question', 'Irreversible question', 'Scope question', 'Bookkeeping question', 'Unclassified question']
      .map((title) => html.indexOf(title));
    expect(titles).toEqual([...titles].sort((left, right) => left - right));
  });

  it('shows each card its class and its stated default label, without pre-selecting the default', () => {
    const items = [classified[0]];
    const html = render({ snapshot: snapshot(items), drafts: draftsFor(items) });
    expect(html).toContain('Default: All tenants');
    expect(html).toMatch(/data-attention-class="bookkeeping"[^>]*>Bookkeeping</);
    expect(html).not.toContain('aria-pressed="true"');
  });

  it('shows Unclassified, never a guessed class, and no default line for an item without them', () => {
    const items = [classified[1]];
    const html = render({ snapshot: snapshot(items), drafts: draftsFor(items) });
    expect(html).toMatch(/data-attention-class="unclassified"[^>]*>Unclassified</);
    expect(html).not.toContain('Default:');
    for (const guess of ['>Money<', '>Scope<', '>Bookkeeping<', '>Irreversible<']) expect(html).not.toContain(guess);
  });

  it('labels an unknown served class neutrally and keeps the served value in detail, never on the face', () => {
    const items = [question({ id: 'odd', class: 'urgent' as never })];
    const html = render({ snapshot: snapshot(items), drafts: draftsFor(items) });
    expect(html).toMatch(/data-attention-class="unclassified"[^>]*title="Served class: urgent"[^>]*>Unrecognised class</);
    expect(html).not.toContain('>urgent<');
    expect(html).toContain('data-attention-class-group="unclassified"');
  });

  it('labels a default that names no served option neutrally instead of showing the raw id', () => {
    const items = [question({ id: 'stale-default', class: 'bookkeeping', defaultOptionId: 'gone' })];
    const html = render({ snapshot: snapshot(items), drafts: draftsFor(items) });
    expect(html).toContain('Default: an option no longer offered');
    expect(html).not.toContain('Default: gone');
  });

  it('needsYouClassGroups keeps the workspace grouping inside each class and skips empty classes', () => {
    const groups = needsYouClassGroups([
      question({ id: 'm-pay', class: 'money', createdAt: 30 }),
      question({ id: 'm-tre', workspaceId: 'ws-tre', class: 'money', createdAt: 10 }),
      question({ id: 'u-pay', createdAt: 5 }),
      question({ id: 'proto', class: 'constructor' as never, createdAt: 6 }),
    ], [workspace('ws-pay', 'Payments'), workspace('ws-tre', 'Treasury')]);
    expect(groups.map((group) => [group.attentionClass, group.workspaces.map((entry) => [entry.workspaceId, entry.items.map((item) => item.id)])])).toEqual([
      ['money', [['ws-tre', ['m-tre']], ['ws-pay', ['m-pay']]]],
      ['unclassified', [['ws-pay', ['u-pay', 'proto']]]],
    ]);
  });

  it('shows a 7-day strip of answers per class, split by human and rule', () => {
    const items = [classified[0]];
    const html = render({
      snapshot: {
        ...snapshot(items),
        generatedAt: today,
        answersByClass: [
          { day: '2026-10-21', class: 'money', by: 'human', count: 2 },
          { day: '2026-10-27', class: 'bookkeeping', by: 'human', count: 1 },
          { day: '2026-10-27', class: 'bookkeeping', by: 'rule', count: 3 },
        ],
      },
      drafts: draftsFor(items),
    });
    expect(html).toContain('Answers per class, last 7 days');
    for (const label of ['10-21', '10-27']) expect(html).toContain(label);
    expect(html).not.toContain('10-20');
    expect(html).toContain('data-strip-cell="2026-10-21:money">2<');
    expect(html).toContain('data-strip-cell="2026-10-27:bookkeeping">4 (3 by rule)<');
    expect(html).toContain('data-strip-cell="2026-10-24:scope">0<');
    expect(today - 6 * day).toBe(Date.UTC(2026, 9, 21, 12, 0, 0));
  });

  it('says the strip is not available when the server does not send answersByClass', () => {
    const items = [classified[0]];
    const html = render({ snapshot: snapshot(items), drafts: draftsFor(items) });
    expect(html).toContain('Answers per class are not available from this server.');
    expect(html).not.toContain('data-strip-cell=');
  });
});

describe('Needs you with an item from a server older than ADR-0031', () => {
  const legacy = (): IMissionAttentionItem => {
    const { class: ignoredClass, defaultOptionId: ignoredDefault, ...shaped } = question({ id: 'legacy', title: 'Legacy question' });
    void ignoredClass;
    void ignoredDefault;
    return shaped as IMissionAttentionItem;
  };

  it('groups and labels an item without both keys Unclassified, with no badge detail and no Default line', () => {
    const items = [legacy()];
    expect(items[0]).not.toHaveProperty('class');
    expect(items[0]).not.toHaveProperty('defaultOptionId');
    const html = render({ snapshot: snapshot(items), drafts: draftsFor(items) });
    expect(html).toContain('data-attention-class-group="unclassified"');
    expect(html).toMatch(/data-attention-class="unclassified">Unclassified</);
    expect(html).not.toContain('title=');
    expect(html).not.toContain('Unrecognised class');
    expect(html).not.toContain('Default:');
    expect(html).not.toContain('undefined');
    expect(html).toContain('Legacy question');
  });
});

describe('Auto-answered section (ADR-0031)', () => {
  const note = (at: string, label: string) =>
    `Auto-answered under fleet config attention.auto-answer.bookkeeping-minutes=30 (version 2) at ${at}: applied the stated default "${label}".`;
  const entry = (over: Partial<IMissionAutoAnsweredItem> = {}): IMissionAutoAnsweredItem => ({
    itemId: 'auto-1', workspaceId: 'ws-pay', runId: 'run-1', title: 'Raise the turn budget?', class: 'bookkeeping',
    appliedOptionId: 'raise', appliedOptionLabel: 'Raise by 20', at: now - 120_000,
    note: note('2026-10-27T08:00:00.000Z', 'Raise by 20'), itemState: 'answered', ...over,
  });
  const withAuto = (autoAnswered: IMissionAutoAnsweredItem[] | undefined, items: IMissionAttentionItem[] = []): IMissionSnapshot =>
    ({ ...snapshot(items), ...(autoAnswered ? { autoAnswered } : {}) });

  it('lists the rule\'s answers newest first, each "Answered by rule" with its default and note', () => {
    const older = entry({ itemId: 'auto-old', title: 'Rotate the log?', appliedOptionLabel: 'Rotate now', at: now - 600_000, itemState: 'resolved', workspaceId: 'ws-tre' });
    const html = render({ snapshot: withAuto([older, entry()]) });

    expect(html).toMatch(/Auto-answered<\/h2><span[^>]*>2<\/span>/);
    const full = render({ snapshot: withAuto(Array.from({ length: 100 }, (_, i) => entry({ itemId: `auto-${i}`, at: now - i * 1000 }))) });
    expect(full).toMatch(/Auto-answered<\/h2><span[^>]*>100\+<\/span>/);
    expect(html.indexOf('Raise the turn budget?')).toBeLessThan(html.indexOf('Rotate the log?'));
    expect(html.match(/Answered by rule/g)).toHaveLength(2);
    expect(html).toContain(note('2026-10-27T08:00:00.000Z', 'Raise by 20').replace(/"/g, '&quot;'));
    expect(html).toContain('Applied default: </span>Raise by 20');
    expect(html).toContain('Answered, waiting for the agent');
    expect(html).toContain('>Resolved<');
    expect(html).toContain('>Payments</span>');
    expect(html).toContain('>Treasury</span>');
    expect(html).toContain('data-attention-class="bookkeeping"');
    expect(html).not.toContain('system:auto-answer');
  });

  it('keeps an auto-answered item out of the Needs you count', () => {
    const answered = question({ id: 'auto-1', state: 'answered', answerId: 'a-1', class: 'bookkeeping', defaultOptionId: 'staged' });
    const html = render({ snapshot: withAuto([entry()], [answered]) });
    expect(html).toMatch(/Needs you<\/h2><span[^>]*>0<\/span>/);
    expect(html).toContain('No confirmed questions need an answer.');
    expect(html).toContain('data-auto-answered-item="auto-1"');
  });

  it.each([['an empty list', []], ['an older server that omits the list', undefined]] as const)('renders no section for %s', (_case, list) => {
    const html = render({ snapshot: withAuto(list as IMissionAutoAnsweredItem[] | undefined) });
    expect(html).not.toContain('Auto-answered');
    expect(html).not.toContain('data-auto-answered-section');
  });

  it('labels an unknown served state neutrally and keeps the served value in detail', () => {
    const html = render({ snapshot: withAuto([entry({ itemState: 'archived' as IMissionAutoAnsweredItem['itemState'] })]) });
    expect(html).toContain('title="Served state: archived">Unknown state<');
  });
});

describe('MissionControlDeliveryCard: who answered', () => {
  const answer = (actor: string): IMissionAnswer => ({
    id: 'a-1', workspaceId: 'ws-pay', runId: 'run-1', itemId: 'q-1', actor, submissionId: 's', expectedRevision: 1, appliedRevision: 1,
    optionIds: ['staged'], text: 'Auto-answered under …', actionCompleted: false, source: null, createdAt: now,
  });

  it('shows "Answered by rule" for the rule\'s answer, never the actor token', () => {
    const item = question({ state: 'answered', answerId: 'a-1', autoAnswer: { rule: 'attention.auto-answer.bookkeeping-minutes', ruleVersion: 2, appliedOptionId: 'staged', at: now, note: 'n' } });
    const html = renderToStaticMarkup(<MissionControlDeliveryCard item={item} answer={answer('system:auto-answer')} delivery={undefined} workspaceName="Payments" />);
    expect(html).toContain('Answered by rule');
    expect(html).not.toContain('system:auto-answer');
  });

  it('shows no rule badge for a human answer', () => {
    const item = question({ state: 'answered', answerId: 'a-1' });
    const html = renderToStaticMarkup(<MissionControlDeliveryCard item={item} answer={answer('user')} delivery={undefined} workspaceName="Payments" />);
    expect(html).not.toContain('Answered by rule');
  });
});
